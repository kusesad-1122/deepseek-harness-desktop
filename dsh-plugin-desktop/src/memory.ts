/** Cordis Host plugin for bounded, cross-session curated memory. */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { MemoryReviewer, ReviewConfig } from './memory-review.ts'
import type {} from './profile-service.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-memory'

/** The active Desktop profile owns the memory directory for this generation. */
export const inject = ['desktopProfiles']

/** One of the two bounded stores. */
export type MemoryTarget = 'memory' | 'user'

/** Single memory operation accepted by the model-facing tool. */
export interface MemoryOperation {
  readonly action: 'add' | 'replace' | 'remove'
  readonly content?: string
  readonly oldText?: string
}

/** Canonical tool result. Business failures are values, not thrown errors. */
export interface MemoryToolResult {
  readonly success: boolean
  readonly target: MemoryTarget
  readonly usage: string
  readonly entryCount: number
  readonly done?: true
  readonly message?: string
  readonly error?: string
  readonly currentEntries?: string[]
  readonly driftBackup?: string
}

/** Bounded-memory policy, including the automatic review rhythm. */
export interface Config extends ReviewConfig {
  /** Inject and manage the agent's MEMORY.md store. */
  memoryEnabled: boolean
  /** Inject and manage the user's USER.md store. */
  userProfileEnabled: boolean
  /** Hard character budget for MEMORY.md (model-independent unit). */
  memoryCharLimit: number
  /** Hard character budget for USER.md. */
  userCharLimit: number
}

/** Validated bounded-memory policy. */
export const Config: z<Config> = z.object({
  memoryEnabled: z.boolean().default(true),
  userProfileEnabled: z.boolean().default(true),
  memoryCharLimit: z.number().step(1).min(1).default(2200),
  userCharLimit: z.number().step(1).min(1).default(1375),
  reviewEnabled: z.boolean().default(true),
  reviewInterval: z.number().step(1).min(1).max(100).default(6),
  reviewCooldownMs: z.number().step(1).min(0).default(60_000),
  reviewTimeoutMs: z.number().step(1).min(1_000).max(300_000).default(60_000),
  reviewMaxDigestChars: z.number().step(1).min(500).default(8_000),
  reviewMaxOutputTokens: z.number().step(1).min(64).max(4_096).default(512),
})

const ENTRY_DELIMITER = '\n§\n'

/** System-prompt headers rendered for each bounded store. */
const BLOCK_HEADERS: Readonly<Record<MemoryTarget, string>> = {
  memory: 'MEMORY (your personal notes)',
  user: 'USER PROFILE (who the user is)',
}

interface MemoryStoreOptions {
  readonly memoryCharLimit: number
  readonly userCharLimit: number
}

interface MemoryWrite {
  readonly action: 'add' | 'replace' | 'remove'
  readonly content?: string
  readonly oldText?: string
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isEnoent(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

/** Trim one model-supplied text value without rejecting empty inputs. */
function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Bounded curated memory with the Hermes frozen-snapshot contract.
 *
 * One instance lives for one Cordis generation. `loadFromDisk()` captures the
 * system-prompt snapshot once; tool writes update disk immediately but never
 * re-render the snapshot, so the active system prompt stays byte-stable and
 * changes become visible to the next generation/session.
 */
export class MemoryStore {
  private readonly entries: Record<MemoryTarget, string[]> = { memory: [], user: [] }
  private snapshot: Record<MemoryTarget, string> = { memory: '', user: '' }
  /** Consecutive consolidation failures; a failed side effect must not stall the turn. */
  private consolidationFailures = 0

  constructor(
    readonly dir: string,
    private readonly options: MemoryStoreOptions,
  ) {}

  /** Read both stores, deduplicate, and freeze the system-prompt snapshot. */
  async loadFromDisk(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const target of ['memory', 'user'] as const) {
      const raw = await readRaw(this.pathFor(target))
      if (raw.readFailed) continue
      this.entries[target] = deduplicate(parseEntries(raw.text))
      this.snapshot[target] = this.renderBlock(target, this.entries[target])
    }
  }

  /** Frozen snapshot text for the enabled targets, or '' when both are empty. */
  snapshotText(enabled: Readonly<Record<MemoryTarget, boolean>>): string {
    const targets: readonly MemoryTarget[] = ['memory', 'user']
    return targets
      .filter(target => enabled[target] && this.snapshot[target] !== '')
      .map(target => this.snapshot[target])
      .join('\n\n')
  }

  /** Apply one validated single operation and return the canonical result. */
  async applySingle(target: MemoryTarget, operation: MemoryWrite): Promise<MemoryToolResult> {
    return this.applyOperations(target, [operation])
  }

  /**
   * Apply a batch atomically against the FINAL budget: every operation is
   * validated before anything is written, and the result commits all-or-nothing.
   */
  async applyOperations(target: MemoryTarget, operations: readonly MemoryWrite[]): Promise<MemoryToolResult> {
    if (operations.length === 0) {
      return this.failure(target, 'operations list is empty.', [])
    }

    return withFileLock(this.pathFor(target), async () => {
      const raw = await readRaw(this.pathFor(target))
      if (raw.readFailed) {
        return this.failure(target, `Refusing to write ${this.fileName(target)}: the file exists but could not be read. Treating it as empty would wipe existing memory, so nothing was changed.`, [])
      }

      const backup = await this.detectExternalDrift(target, raw.text)
      if (backup !== null) {
        return {
          ...this.failure(target, `Refusing to write ${this.fileName(target)}: the file on disk has content that would not round-trip through the memory tool. A snapshot was saved to ${backup}. Resolve the drift first, then retry.`, []),
          driftBackup: backup,
        }
      }

      const fresh = deduplicate(parseEntries(raw.text))
      this.entries[target] = fresh
      const working = [...fresh]
      for (const operation of operations) {
        const error = this.validateStep(working, operation)
        if (error !== null) return this.failure(target, error, fresh)
      }

      const total = joinEntries(working).length
      if (total > this.charLimit(target)) {
        const current = joinEntries(fresh).length
        return this.consolidationFailure(target, current, `After applying all ${String(operations.length)} operation(s), memory would be at ${String(total)}/${String(this.charLimit(target))} chars — over the limit. Remove or shorten more entries in the same batch, then retry.`, fresh)
      }

      this.entries[target] = working
      await writeFileAtomic(this.pathFor(target), joinEntries(working), { mode: 0o600, dirMode: 0o700 })
      return this.success(target, `Applied ${String(operations.length)} operation(s).`)
    })
  }

  /** Read the current live state for diagnostics or approval surfaces. */
  currentEntries(target: MemoryTarget): string[] {
    return [...this.entries[target]]
  }

  /** Current joined character count of one store. */
  charCount(target: MemoryTarget): number {
    return joinEntries(this.entries[target]).length
  }

  private validateStep(working: string[], operation: MemoryWrite): string | null {
    const action = operation.action
    const content = clean(operation.content)
    const oldText = clean(operation.oldText)
    if (action === 'add') {
      if (content === '') return 'add requires non-empty content.'
      if (working.includes(content)) return null
      working.push(content)
      return null
    }
    if (oldText === '') return `${action} requires oldText — a short unique substring of the entry to ${action}.`
    if (action === 'replace' && content === '') return 'replace requires non-empty content (use remove to delete an entry).'

    const matches = working.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.includes(oldText))
    if (matches.length === 0) return `No entry matched '${oldText}'. Check currentEntries below and retry with the exact text of the entry you want to ${action}.`
    if (new Set(matches.map(({ entry }) => entry)).size > 1) {
      return `Multiple entries matched '${oldText}'. Be more specific.`
    }
    if (action === 'replace') {
      working[matches[0]!.index] = content
    } else {
      working.splice(matches[0]!.index, 1)
    }
    return null
  }

  /** Detect on-disk content the tool did not write, and snapshot it before refusing. */
  private async detectExternalDrift(target: MemoryTarget, raw: string): Promise<string | null> {
    if (raw.trim() === '') return null
    const parsed = parseEntries(raw)
    const roundtrip = joinEntries(parsed)
    const oversized = parsed.some(entry => entry.length > this.charLimit(target))
    if (raw.trim() === roundtrip && !oversized) return null
    const backup = `${this.pathFor(target)}.bak.${String(Date.now())}`
    await writeFile(backup, raw, 'utf8')
    return backup
  }

  private pathFor(target: MemoryTarget): string {
    return join(this.dir, this.fileName(target))
  }

  private fileName(target: MemoryTarget): string {
    return target === 'user' ? 'USER.md' : 'MEMORY.md'
  }

  private charLimit(target: MemoryTarget): number {
    return target === 'user' ? this.options.userCharLimit : this.options.memoryCharLimit
  }

  private renderBlock(target: MemoryTarget, entries: readonly string[]): string {
    if (entries.length === 0) return ''
    const content = joinEntries(entries)
    const percent = Math.min(100, Math.floor((content.length / this.charLimit(target)) * 100))
    const header = `${BLOCK_HEADERS[target]} [${String(percent)}% — ${String(content.length)}/${String(this.charLimit(target))} chars]`
    const separator = '═'.repeat(46)
    return `${separator}\n${header}\n${separator}\n${content}`
  }

  private success(target: MemoryTarget, message: string): MemoryToolResult {
    this.consolidationFailures = 0
    return {
      success: true,
      done: true,
      target,
      usage: this.usage(target),
      entryCount: this.entries[target].length,
      message: `${message} Write saved. This update is complete — do not repeat it.`,
    }
  }

  private failure(target: MemoryTarget, error: string, entries: readonly string[]): MemoryToolResult {
    return {
      success: false,
      target,
      usage: this.usage(target),
      entryCount: entries.length,
      error,
      ...(entries.length === 0 ? {} : { currentEntries: [...entries] }),
    }
  }

  /**
   * Budget failures instruct the model to consolidate and retry in the same
   * turn — but only a bounded number of times. Past the cap the result becomes
   * terminal so a fragile retry loop can never suppress the user's reply.
   */
  private consolidationFailure(target: MemoryTarget, current: number, error: string, entries: readonly string[]): MemoryToolResult {
    this.consolidationFailures += 1
    const base: MemoryToolResult = {
      success: false,
      target,
      usage: `${String(current)}/${String(this.charLimit(target))} chars`,
      entryCount: entries.length,
      currentEntries: [...entries],
      error,
    }
    if (this.consolidationFailures > 3) {
      return {
        ...base,
        done: true,
        error: `${error} Memory consolidation failed ${String(this.consolidationFailures)} times this turn. Stop retrying memory calls — leave memory unchanged and continue with your reply to the user. The fact can be saved in a later turn.`,
      }
    }
    return base
  }

  private usage(target: MemoryTarget): string {
    const current = this.charCount(target)
    const percent = Math.min(100, Math.floor((current / this.charLimit(target)) * 100))
    return `${String(percent)}% — ${String(current)}/${String(this.charLimit(target))} chars`
  }
}

interface RawRead {
  readonly text: string
  readonly readFailed: boolean
}

async function readRaw(path: string): Promise<RawRead> {
  try {
    return { text: await readFile(path, 'utf8'), readFailed: false }
  } catch (error) {
    if (isEnoent(error)) return { text: '', readFailed: false }
    return { text: '', readFailed: true }
  }
}

function parseEntries(raw: string): string[] {
  if (raw.trim() === '') return []
  return raw.split(ENTRY_DELIMITER).map(entry => entry.trim()).filter(entry => entry !== '')
}

function deduplicate(entries: readonly string[]): string[] {
  return [...new Set(entries)]
}

function joinEntries(entries: readonly string[]): string {
  return entries.join(ENTRY_DELIMITER)
}

const TOOL_DESCRIPTION = [
  'Manage bounded, cross-session memory stored in MEMORY.md and USER.md.',
  'Two targets: "memory" keeps your own durable notes (environment facts, project conventions, lessons learned); "user" keeps what you know about the user (preferences, communication style, expectations).',
  `Entries are separated by '§' and may be multiline. Each store has a hard character budget: writes that would exceed it fail and return currentEntries plus usage so you can consolidate first (use replace to merge overlapping entries or remove stale ones, then retry in the same batch).`,
  'replace/remove locate an entry by a short UNIQUE substring via oldText; multiple distinct matches fail and ask you to be more specific.',
  'Pass operations=[{action, content?, oldText?}] to apply an all-or-nothing batch against the FINAL budget in one call.',
  'Writes are durable immediately but enter the system prompt only on the next session, so the active prompt stays stable.',
  'Save durable facts and preferences; skip trivial facts, raw data dumps, and session-specific ephemera.',
].join(' ')

const MEMORY_TOOL_PARAMETERS = {
  action: {
    type: 'string' as const,
    enum: ['add', 'replace', 'remove'] as const,
    description: 'Single-op action. Omit when using operations.',
  },
  target: {
    type: 'string' as const,
    enum: ['memory', 'user'] as const,
    description: "Which store to modify. Defaults to 'memory'.",
  },
  content: {
    type: 'string' as const,
    description: 'Entry text for add, or replacement text for replace. Multiline allowed.',
  },
  oldText: {
    type: 'string' as const,
    description: 'Short unique substring identifying the entry to replace or remove.',
  },
  newText: {
    type: 'string' as const,
    description: 'Alias for content on replace calls.',
  },
  operations: {
    type: 'array' as const,
    description: 'Optional atomic batch of operations.',
    items: {
      type: 'object' as const,
      additionalProperties: false as const,
      properties: {
        action: {
          type: 'string' as const,
          required: true as const,
          enum: ['add', 'replace', 'remove'] as const,
          description: 'One operation to apply in order.',
        },
        content: { type: 'string' as const, description: 'New entry or replacement text.' },
        oldText: { type: 'string' as const, description: 'Unique substring of the target entry.' },
      },
    },
  },
}

const MEMORY_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false as const,
  properties: {
    success: { type: 'boolean' as const, required: true as const },
    target: { type: 'string' as const, required: true as const, enum: ['memory', 'user'] as const },
    usage: { type: 'string' as const, required: true as const },
    entryCount: { type: 'integer' as const, required: true as const },
    done: { type: 'boolean' as const },
    message: { type: 'string' as const },
    error: { type: 'string' as const },
    currentEntries: { type: 'array' as const, items: { type: 'string' as const } },
    driftBackup: { type: 'string' as const },
  },
}

interface MemoryToolArguments {
  readonly action?: string
  readonly target?: string
  readonly content?: string
  readonly oldText?: string
  readonly newText?: string
  readonly operations?: Array<{ readonly action?: string, readonly content?: string, readonly oldText?: string }>
}

function normalizeTarget(target: unknown): MemoryTarget {
  return target === 'user' ? 'user' : 'memory'
}

function normalizeOperations(args: MemoryToolArguments): MemoryWrite[] {
  if (Array.isArray(args.operations) && args.operations.length > 0) {
    return args.operations.map((operation, index): MemoryWrite => {
      const action = operation.action
      if (action !== 'add' && action !== 'replace' && action !== 'remove') {
        throw new Error(`operations[${String(index)}].action must be add, replace, or remove`)
      }
      const content = clean(operation.content)
      const oldText = clean(operation.oldText)
      return {
        action,
        ...(content === '' ? {} : { content }),
        ...(oldText === '' ? {} : { oldText }),
      }
    })
  }
  const action = args.action
  if (action !== 'add' && action !== 'replace' && action !== 'remove') {
    throw new Error('action must be add, replace, or remove')
  }
  const content = clean([args.content, args.newText].find(value => value !== undefined && value !== '') ?? '')
  const oldText = clean(args.oldText)
  return [{
    action,
    ...(content === '' ? {} : { content }),
    ...(oldText === '' ? {} : { oldText }),
  }]
}

/**
 * Register the frozen system-prompt section and the `memory` tool.
 * @param ctx - registrant context carrying the Desktop profile identity.
 * @param config - validated bounded-memory policy.
 */
export function apply(ctx: Context, config: Config): void {
  const store = new MemoryStore(join(ctx.desktopProfiles.current.dir, 'memory'), {
    memoryCharLimit: config.memoryCharLimit,
    userCharLimit: config.userCharLimit,
  })
  const reviewer = new MemoryReviewer(join(ctx.desktopProfiles.current.dir, 'memory'))

  ctx.effect(async () => {
    try {
      await store.loadFromDisk()
      await reviewer.loadState()
    } catch (error) {
      ctx.logger.warn('dsh-plugin-desktop: memory store failed to load; continuing with an empty store: %s', String(error))
    }

    const disposers: Array<() => void> = []
    if (config.memoryEnabled || config.userProfileEnabled) {
      const snapshot = store.snapshotText({ memory: config.memoryEnabled, user: config.userProfileEnabled })
      if (snapshot !== '') {
        disposers.push(ctx.systemPrompt.section({ name: 'memory', order: 300, text: snapshot }))
      }
      disposers.push(ctx.tools.register(defineTool({
        name: 'memory',
        description: TOOL_DESCRIPTION,
        parameters: MEMORY_TOOL_PARAMETERS,
        output: {
          schema: MEMORY_OUTPUT_SCHEMA,
          render: (_args, value) => [{
            type: 'text',
            text: value.success ? `${value.target}: ${value.message ?? 'Memory updated.'}` : (value.error ?? 'Memory write failed.'),
          }],
        },
        execute: (args: unknown, _exec) => {
          const input = args as MemoryToolArguments
          const target = normalizeTarget(input.target)
          return store.applyOperations(target, normalizeOperations(input))
        },
        presentCall: args => ({
          card: 'generic',
          title: 'Update memory',
          kind: 'other',
          rawInput: (args as { operations?: unknown, action?: unknown }).operations ?? (args as { action?: unknown }).action,
        }),
      })))
      disposers.push(ctx.commands.register({
        name: 'memory',
        description: 'Show current cross-session memory, usage, and review state',
        handler: () => ({ kind: 'success', text: renderMemoryStatus(store, reviewer, config) }),
      }))
    }

    // Hermes L4 learning loop: every N user turns, a detached one-shot review
    // curates durable entries through the same guarded store path.
    if (config.reviewEnabled) {
      disposers.push(reviewer.attach(ctx, store, config))
    }

    return () => {
      for (const dispose of [...disposers].reverse()) dispose()
    }
  }, 'dsh-plugin-desktop: bounded cross-session memory')
}

/** Human-readable `/memory` view: live entries, budgets, and review rhythm. */
function renderMemoryStatus(store: MemoryStore, reviewer: MemoryReviewer, config: Config): string {
  const targets: readonly MemoryTarget[] = ['memory', 'user']
  const sections = targets.map((target) => {
    const entries = store.currentEntries(target)
    const header = `${BLOCK_HEADERS[target]} [${store.charCount(target)}/${String(target === 'user' ? config.userCharLimit : config.memoryCharLimit)} chars, ${String(entries.length)} entries]`
    const body = entries.length === 0 ? '(empty)' : entries.map((entry, index) => `${String(index + 1)}. ${entry}`).join('\n')
    return `${header}\n${body}`
  })
  const reviewed = reviewer.lastReviewedSecondsAgo()
  const rhythm = reviewed < 0
    ? 'no automatic review has run yet'
    : `last automatic review ${String(reviewed)}s ago (every ${String(config.reviewInterval)} user turns)`
  return `${sections.join('\n\n')}\n\nreview: ${config.reviewEnabled ? 'enabled' : 'disabled'} — ${rhythm}`
}
