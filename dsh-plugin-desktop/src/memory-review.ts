/**
 * Hermes-style automatic memory review (the L4 learning loop) for the desktop
 * memory plugin.
 *
 * Hermes triggers a background review every N user turns and forks a child
 * agent that may only call `memory`. This DSH port keeps the same discipline
 * with native seams:
 *
 * - `agent/turn-stopping` provides the turn rhythm. The listener returns
 *   immediately and the review runs detached, so it never delays the reply or
 *   the next turn.
 * - The review is ONE bounded `ctx.llm.stream()` call (no tool loop, no child
 *   agent), and it does not stamp a sessionId, so the auxiliary request and
 *   its output never enter the user's session log.
 * - Every write goes through the same `MemoryStore.applyOperations()` path as
 *   the model-facing `memory` tool: same lock, same drift detection, same
 *   hard character budget, same deduplication. The reviewer itself cannot
 *   bypass memory policy.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { MemoryStore } from './memory.ts'

/** Automatic background-review policy, validated from the cordis patch row. */
export interface ReviewConfig {
  /** Run the automatic review loop at all. */
  reviewEnabled: boolean
  /** User turns between automatic reviews (Hermes default rhythm: 10). */
  reviewInterval: number
  /** Minimum wall-clock time between reviews, guards restart/turn bursts. */
  reviewCooldownMs: number
  /** Hard timeout for one review LLM call. */
  reviewTimeoutMs: number
  /** Character cap on the conversation digest fed to the reviewer. */
  reviewMaxDigestChars: number
  /** Output-token cap for one review LLM call. */
  reviewMaxOutputTokens: number
}

export const ReviewConfig: z<ReviewConfig> = z.object({
  reviewEnabled: z.boolean().default(true),
  reviewInterval: z.number().step(1).min(1).max(100).default(6),
  reviewCooldownMs: z.number().step(1).min(0).default(60_000),
  reviewTimeoutMs: z.number().step(1).min(1_000).max(300_000).default(60_000),
  reviewMaxDigestChars: z.number().step(1).min(500).default(8_000),
  reviewMaxOutputTokens: z.number().step(1).min(64).max(4_096).default(512),
})

const STATE_FILE = 'review-state.json'

const MAX_DIGEST_LINES = 24
const MAX_ASSISTANT_LINE_CHARS = 600
const MAX_ENTRY_CHARS = 500
const MAX_ENTRIES_PER_STORE = 8

/** Curation policy: what is and is not durable memory. Mirrors Hermes' review prompt discipline. */
const REVIEW_SYSTEM_PROMPT = [
  'You are the memory curator for a coding assistant, applying the Hermes memory-review policy.',
  'Review the conversation digest and decide what belongs in durable cross-session memory.',
  '',
  'CAPTURE only these kinds of facts:',
  '- Facts the user revealed about themselves (identity, projects, environment, constraints, accounts).',
  '- Explicit expectations about how you should behave or work (style, workflow, rules, corrections the user cared about).',
  '- Durable project facts and decisions the user confirmed.',
  '',
  'NEVER capture: trivial facts, raw data dumps, transient failures, missing tools or uninstalled deps, resolved one-off errors, one-off task narratives, unverified dead ends, or anything already present in the digest as an existing memory snapshot.',
  '',
  'Keep each entry a single concise statement of at most 200 characters, in the language the user writes in.',
  'If nothing meets the bar, reply with exactly: Nothing to save.',
  'Otherwise reply with ONLY strict JSON and nothing else, using this exact shape:',
  '{"memory":["entry","..."],"user":["entry","..."]}',
  'Use "memory" for project/environment notes; use "user" for facts and preferences about the user.',
].join('\n')

const REVIEW_USER_PREFIX = [
  'Conversation digest (most recent turns last). Curate memory from this digest only.',
  '',
].join('\n')

/** Parse the reviewer output; accepts an exact "Nothing to save." or a strict JSON object. */
export function parseReviewOutput(text: string): { memory: string[], user: string[] } {
  const trimmed = text.trim()
  if (/^Nothing to save\.?$/i.test(trimmed)) return { memory: [], user: [] }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`memory review produced unparsable output: ${trimmed.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown
  } catch (error) {
    throw new Error(`memory review produced invalid JSON: ${String(error)}`)
  }
  const record = parsed as Record<string, unknown>
  return {
    memory: stringArray(record['memory']),
    user: stringArray(record['user']),
  }
}

/** Bounded, trimmed string list from an untrusted JSON value. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const entry = item.trim().slice(0, MAX_ENTRY_CHARS)
    if (entry !== '') result.push(entry)
    if (result.length >= MAX_ENTRIES_PER_STORE) break
  }
  return result
}

function textOfBlocks(content: readonly ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface DigestEventData {
  readonly content?: readonly ContentBlock[]
  readonly message?: { readonly content?: readonly ContentBlock[] }
  readonly source?: { readonly kind?: string }
}

/**
 * Build a bounded digest from the live session log: recent human messages plus
 * capped assistant replies. Injected plugin/instruction messages are skipped,
 * matching Hermes' "strip scaffolding before feeding memory" rule.
 */
export function extractReviewDigest(agent: Agent, maxChars: number): string {
  const events = [...agent.session.events]
  const lines: string[] = []
  let totalChars = 0
  for (let index = events.length - 1; index >= 0 && lines.length < MAX_DIGEST_LINES; index -= 1) {
    const event = events[index]!
    if (event.type === 'user/message') {
      const data = event.data as DigestEventData
      if (data.source?.kind !== 'user') continue
      const text = textOfBlocks(data.content)
      if (text === '') continue
      lines.unshift(`用户: ${text}`)
      totalChars += text.length
    } else if (event.type === 'assistant/message') {
      const data = event.data as DigestEventData
      const text = textOfBlocks(data.message?.content)
      if (text === '') continue
      const capped = text.length > MAX_ASSISTANT_LINE_CHARS ? `${text.slice(0, MAX_ASSISTANT_LINE_CHARS)}…` : text
      lines.unshift(`助手: ${capped}`)
      totalChars += capped.length
    }
    if (totalChars > maxChars * 2) break
  }
  return lines.join('\n\n').slice(-maxChars)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isEnoent(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

interface ReviewState {
  readonly lastReviewedAt: number
  readonly memoryAdded?: number
  readonly userAdded?: number
}

/**
 * Turn-rhythm state machine for automatic memory review. One instance per
 * Cordis generation, like the frozen memory snapshot.
 */
export class MemoryReviewer {
  private turnsSinceReview = 0
  private running = false
  private lastReviewedAt = 0

  constructor(private readonly dir: string) {}

  /** Restore the last review timestamp so restarts don't immediately re-review. */
  async loadState(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      const raw = await readFile(join(this.dir, STATE_FILE), 'utf8')
      const state = JSON.parse(raw) as Partial<ReviewState>
      if (typeof state.lastReviewedAt === 'number' && Number.isFinite(state.lastReviewedAt)) {
        this.lastReviewedAt = state.lastReviewedAt
      }
    } catch (error) {
      if (!isEnoent(error)) {
        // Unreadable state never blocks memory: start with a clean rhythm.
      }
    }
  }

  /**
   * Register the turn rhythm. Returns the disposer.
   * The listener returns immediately; the actual review is detached.
   */
  attach(ctx: Context, store: MemoryStore, config: ReviewConfig): () => void {
    return ctx.on('agent/turn-stopping', ({ agent }) => {
      if (!config.reviewEnabled || this.running) return
      this.turnsSinceReview += 1
      const due = this.turnsSinceReview >= config.reviewInterval
        && Date.now() - this.lastReviewedAt >= config.reviewCooldownMs
      if (!due) return
      this.turnsSinceReview = 0
      this.running = true
      void this.run(ctx, store, config, agent)
        .catch((error: unknown) => {
          ctx.logger.warn('dsh-plugin-desktop: background memory review failed: %s', String(error))
        })
        .finally(() => {
          this.running = false
        })
    })
  }

  /** Seconds since the last successful review, for diagnostics. */
  lastReviewedSecondsAgo(): number {
    return this.lastReviewedAt === 0 ? -1 : Math.floor((Date.now() - this.lastReviewedAt) / 1000)
  }

  private async run(ctx: Context, store: MemoryStore, config: ReviewConfig, agent: Agent): Promise<void> {
    const digest = extractReviewDigest(agent, config.reviewMaxDigestChars)
    if (digest === '') return
    const provider = agent.options.provider
    const model = agent.options.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      ctx.logger.warn('dsh-plugin-desktop: memory review skipped: agent has no provider/model route')
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`memory review timed out after ${String(config.reviewTimeoutMs)}ms`))
    }, config.reviewTimeoutMs)
    try {
      const messages: Message[] = [createUserMessage({
        content: [{ type: 'text', text: REVIEW_USER_PREFIX + digest }],
        source: { kind: 'plugin', plugin: 'dsh-plugin-desktop-memory-review' },
      })]
      const options: GenerateOptions = {
        provider,
        model,
        messages,
        system: REVIEW_SYSTEM_PROMPT,
        maxTokens: config.reviewMaxOutputTokens,
        signal: controller.signal,
      }
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
      const finish = assembler.finish
      if (finish.kind === 'error') {
        throw new Error(finish.failure.message)
      }
      const text = textOfBlocks(assembler.blocks())
      const result = parseReviewOutput(text)

      const memoryOps = result.memory.map(content => ({ action: 'add' as const, content }))
      const userOps = result.user.map(content => ({ action: 'add' as const, content }))
      if (memoryOps.length > 0) await store.applyOperations('memory', memoryOps)
      if (userOps.length > 0) await store.applyOperations('user', userOps)

      this.lastReviewedAt = Date.now()
      await this.saveState({ lastReviewedAt: this.lastReviewedAt, memoryAdded: memoryOps.length, userAdded: userOps.length })
      ctx.logger.info(
        'dsh-plugin-desktop: memory review saved %d memory + %d user entries',
        memoryOps.length,
        userOps.length,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private async saveState(state: ReviewState): Promise<void> {
    await writeFileAtomic(join(this.dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n', {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}
