/**
 * Host plugin for the structured knowledge-card store ("structured B"):
 * the durable counterpart of the free-text MEMORY.md/USER.md entries.
 *
 * A knowledge card is a small structured record — title, summary, tags —
 * stored as JSON under the active profile. Cards are written by three
 * origins: the user-facing `/distill` command (LLM distillation of the
 * current session), the model-facing `knowledge` tool (registered by the
 * harness-side `knowledge-web` bundle), and the knowledge panel routes.
 *
 * The harness auto-retrieval seam reads the same store through
 * `knowledge-routes.ts` (`/dsh-desktop/knowledge/retrieve`), so the
 * model-facing prompt can be enriched with only the cards relevant to the
 * current turn — see `knowledge-web.ts`.
 *
 * All mutation paths funnel through `KnowledgeStore` so the same lock,
 * budget, and deduplication discipline applies everywhere, mirroring how
 * `MemoryStore.applyOperations()` owns every MEMORY.md/USER.md write.
 */

import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { extractReviewDigest } from './memory-review.ts'
import { mountKnowledgeRoutes } from './knowledge-routes.ts'
import type {} from './profile-service.ts'
import { UnifiedDb, defaultUnifiedDbPath } from './store/unified-db.ts'
import { migrateFromFiles } from './store/migrate.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-knowledge'

/**
 * Services the knowledge plugin drives. The `/distill` command streams
 * through `llm`; commands and the store live on the host. These MUST be
 * declared here: Cordis' service guard throws on any undeclared access.
 */
export const inject = ['desktopProfiles', 'commands', 'llm']

/** Where a knowledge card came from; carried into the audit record. */
export type KnowledgeOrigin = 'manual' | 'distill' | 'model'

/**
 * One structured knowledge card (the "structured B" record).
 * Fixed fields keep the store machine-searchable without an embedding
 * service; `tags` drive keyword auto-retrieval, `title` deduplication.
 */
export interface KnowledgeCard {
  /** Stable opaque id (timestamp-base36 + random hex). */
  readonly id: string
  /** Short title; the deduplication key (case-insensitive). */
  readonly title: string
  /** Concise durable summary of the fact. */
  readonly summary: string
  /** Up to {@link Config.maxTags} short tags. */
  readonly tags: readonly string[]
  /** Who created the card. */
  readonly source: KnowledgeOrigin
  /** ISO timestamp of creation. */
  readonly createdAt: string
  /** ISO timestamp of the last update. */
  readonly updatedAt: string
}

/** One validated card write accepted by the store. */
export interface KnowledgeCardInput {
  readonly title: string
  readonly summary: string
  readonly tags?: readonly string[]
}

/** Canonical result of one knowledge operation; business failures are values. */
export interface KnowledgeResult {
  readonly success: boolean
  readonly card?: KnowledgeCard
  readonly cards?: readonly KnowledgeCard[]
  readonly count?: number
  readonly charCount?: number
  readonly message?: string
  readonly error?: string
}

/** Bounded knowledge-card policy, validated from the cordis patch row. */
export interface Config {
  /** Mount the knowledge store, routes, and commands at all. */
  enabled: boolean
  /** Hard cap on the number of cards in the store. */
  maxCards: number
  /** Hard character budget for one card's title. */
  titleCharLimit: number
  /** Hard character budget for one card's summary. */
  cardCharLimit: number
  /** Hard cap on the number of tags per card. */
  maxTags: number
  /** Hard character budget for one tag. */
  tagCharLimit: number
  /** Default top-K for auto-retrieval prompt injection. */
  retrieveTopK: number
  /** Whether the harness injects retrieved cards into the system prompt. */
  autoRetrieval: boolean
}

/** Validated bounded knowledge-card policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  maxCards: z.number().step(1).min(1).max(10_000).default(500),
  titleCharLimit: z.number().step(1).min(1).max(500).default(80),
  cardCharLimit: z.number().step(1).min(1).max(4_000).default(600),
  maxTags: z.number().step(1).min(0).max(20).default(8),
  tagCharLimit: z.number().step(1).min(1).max(100).default(24),
  retrieveTopK: z.number().step(1).min(1).max(20).default(4),
  autoRetrieval: z.boolean().default(true),
})

/** Knowledge store file name under the profile's knowledge directory. */
const KNOWLEDGE_FILE = 'knowledge.json'
/** Audit log for every accepted or rejected card write. */
const AUDIT_FILE = 'knowledge-audit.jsonl'
/** Distinct cards accepted per `/distill` run. */
const MAX_DISTILL_CARDS = 8
/** Max chars for one distill-produced title / summary / tag. */
const DISTILL_TITLE_LIMIT = 80
const DISTILL_SUMMARY_LIMIT = 600
const DISTILL_TAG_LIMIT = 24
const DISTILL_MAX_TAGS = 8

/** Persisted store document shape. */
interface KnowledgeDocument {
  readonly version: 1
  readonly cards: KnowledgeCard[]
}

interface AuditRecord {
  readonly time: string
  readonly origin: KnowledgeOrigin
  readonly outcome: string
  readonly title?: string
  readonly id?: string
  readonly error?: string
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isEnoent(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isValidKnowledgeCard(value: unknown): value is KnowledgeCard {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const card = value as Record<string, unknown>
  return typeof card.id === 'string'
    && card.id.length > 0
    && typeof card.title === 'string'
    && card.title.length > 0
    && typeof card.summary === 'string'
    && card.summary.length > 0
    && Array.isArray(card.tags)
    && card.tags.every(tag => typeof tag === 'string' && tag.length > 0)
    && (card.source === 'manual' || card.source === 'distill' || card.source === 'model')
    && typeof card.createdAt === 'string'
    && Number.isFinite(Date.parse(card.createdAt))
    && typeof card.updatedAt === 'string'
    && Number.isFinite(Date.parse(card.updatedAt))
    && Object.keys(card).every(key => ['id', 'title', 'summary', 'tags', 'source', 'createdAt', 'updatedAt'].includes(key))
}

/** Trim one untrusted text value without rejecting empty inputs. */
function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Stable card id: timestamp base36 + 4 random bytes, like pending memory ids. */
function newCardId(): string {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`
}

/** Case-insensitive title equality used for deduplication. */
function sameTitle(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase()
}

/** Split a query into match terms: whitespace tokens plus CJK bigrams. */
export function tokenizeQuery(query: string): string[] {
  const text = query.trim().toLocaleLowerCase()
  if (text === '') return []
  const terms = new Set<string>()
  for (const token of text.split(/\s+/u)) {
    if (token === '') continue
    // Latin/digit tokens match as-is; CJK text has no word boundaries, so
    // every adjacent bigram is a candidate term.
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(token)) {
      const chars = [...token]
      if (chars.length === 1) {
        terms.add(token)
      } else {
        for (let index = 0; index < chars.length - 1; index += 1) {
          terms.add(chars[index]! + chars[index + 1]!)
        }
      }
    } else {
      terms.add(token)
    }
  }
  return [...terms]
}

/**
 * Bounded structured knowledge store. One instance lives for one Cordis
 * generation; every write is atomic and durable, and file writes are
 * serialized through a queue so concurrent writers (distill command, model
 * tool, panel) cannot clobber each other's committed state.
 */
export class KnowledgeStore {
  private cards: KnowledgeCard[] = []
  /** Serialized file-write chain: concurrent commits cannot interleave. */
  private writeQueue: Promise<void> = Promise.resolve()
  private unifiedDb: UnifiedDb | null = null

  constructor(
    readonly dir: string,
    private readonly options: Config,
  ) {}

  private async ensureUnifiedDb(): Promise<UnifiedDb | null> {
    if (this.unifiedDb !== null && this.unifiedDb.isOpen()) return this.unifiedDb
    try {
      const profileDir = join(this.dir, '..')
      const dbPath = defaultUnifiedDbPath(profileDir)
      const db = new UnifiedDb(dbPath, {
        memoryCharLimit: 2200,
        userCharLimit: 1375,
        maxCards: this.options.maxCards,
      })
      db.open()
      await migrateFromFiles(profileDir, db)
      this.unifiedDb = db
      return db
    } catch {
      return null
    }
  }

  private async mirrorCardToUnified(card: KnowledgeCard): Promise<void> {
    const db = await this.ensureUnifiedDb()
    if (db === null) return
    try {
      const existing = db.getKnowledgeCard(card.id)
      if (existing !== undefined) {
        try { db.updateKnowledgeCard(card.id, { title: card.title, summary: card.summary, tags: [...card.tags] }) } catch {}
      } else {
        // Title dedup may cause failure if another card has same title; treat as best-effort
        try { db.addKnowledgeCard({ title: card.title, summary: card.summary, tags: [...card.tags], source: card.source }) } catch {}
      }
    } catch {}
  }

  private async mirrorDeleteToUnified(id: string): Promise<void> {
    const db = await this.ensureUnifiedDb()
    if (db === null) return
    try { db.deleteKnowledgeCard(id) } catch {}
  }

  /** Load the store document; a missing or unreadable file starts empty. */
  async loadFromDisk(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const raw = await this.readRaw(join(this.dir, KNOWLEDGE_FILE))
    if (raw.readFailed || raw.text.trim() === '') {
      // Even if file is empty, try to hydrate from unified DB (migration target)
      try {
        const db = await this.ensureUnifiedDb()
        if (db !== null) {
          const cards = db.listKnowledgeCards()
          if (cards.length > 0) {
            this.cards = cards.map(c => ({
              id: c.id,
              title: c.title,
              summary: c.summary,
              tags: [...c.tags],
              source: c.source,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
            })).slice(0, this.options.maxCards)
            return
          }
        }
      } catch {}
      return
    }
    try {
      const parsed = JSON.parse(raw.text) as Partial<KnowledgeDocument>
      if (!Array.isArray(parsed.cards)) return
      const valid = parsed.cards.filter((card): card is KnowledgeCard => {
        return isValidKnowledgeCard(card)
      })
      this.cards = valid.map(card => ({ ...card, tags: [...card.tags] })).slice(0, this.options.maxCards)
      // Hydrate unified DB in background (best-effort mirror)
      void this.ensureUnifiedDb().then(async db => {
        if (db === null) return
        for (const card of this.cards) await this.mirrorCardToUnified(card)
      })
    } catch {
      // Unreadable store never blocks boot: start empty.
    }
  }

  /** All cards in insertion order (detached copy). */
  allCards(): KnowledgeCard[] {
    return [...this.cards]
  }

  /** Total card count. */
  count(): number {
    return this.cards.length
  }

  /** Total joined character count of every title + summary, for the panel. */
  charCount(): number {
    return this.cards.reduce((total, card) => total + card.title.length + card.summary.length, 0)
  }

  /** Find one card by exact id. */
  cardById(id: string): KnowledgeCard | undefined {
    return this.cards.find(card => card.id === id)
  }

  /**
   * Keyword search over title / tags / summary. Tags weigh highest, then the
   * title, then the summary; results are bounded and ordered by score.
   * This is the no-embedding retrieval seam behind auto-retrieval.
   */
  search(query: string, limit: number): KnowledgeCard[] {
    const terms = tokenizeQuery(query)
    if (terms.length === 0) return []
    const scored: Array<{ card: KnowledgeCard, score: number }> = []
    for (const card of this.cards) {
      const title = card.title.toLocaleLowerCase()
      const summary = card.summary.toLocaleLowerCase()
      const tags = card.tags.map(tag => tag.toLocaleLowerCase())
      let score = 0
      for (const term of terms) {
        if (tags.some(tag => tag.includes(term))) score += 4
        if (title.includes(term)) score += 2
        if (summary.includes(term)) score += 1
      }
      if (score > 0) scored.push({ card, score })
    }
    scored.sort((a, b) => b.score - a.score || a.card.createdAt.localeCompare(b.card.createdAt))
    return scored.slice(0, Math.max(1, Math.min(limit, 20))).map(entry => entry.card)
  }

  /** Top-K retrieval for prompt injection; empty query returns the newest cards. */
  retrieve(query: string, topK: number): KnowledgeCard[] {
    const limit = Math.max(1, Math.min(topK, 20))
    if (query.trim() === '') {
      return [...this.cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit)
    }
    return this.search(query, limit)
  }

  /** Add one card; a title duplicate returns the existing card untouched. */
  async addCard(input: KnowledgeCardInput, origin: KnowledgeOrigin): Promise<KnowledgeResult> {
    const title = clean(input.title)
    const summary = clean(input.summary)
    if (title === '') return this.failure('title is required.')
    if (summary === '') return this.failure('summary is required.')
    const tags = this.normalizeTags(input.tags)

    const duplicate = this.cards.find(card => sameTitle(card.title, title))
    if (duplicate !== undefined) {
      await this.audit({ time: new Date().toISOString(), origin, outcome: 'duplicate', title })
      return {
        success: true,
        card: duplicate,
        count: this.cards.length,
        charCount: this.charCount(),
        message: 'A card with this title already exists; nothing was changed.',
      }
    }
    if (this.cards.length >= this.options.maxCards) {
      const error = `Knowledge store is full (${String(this.options.maxCards)} cards). Delete cards first, or merge this fact into an existing card.`
      await this.audit({ time: new Date().toISOString(), origin, outcome: 'full', title, error })
      return this.failure(error)
    }

    const now = new Date().toISOString()
    const card: KnowledgeCard = {
      id: newCardId(),
      title,
      summary,
      tags,
      source: origin,
      createdAt: now,
      updatedAt: now,
    }
    await this.commit([...this.cards, card], origin, 'added', title)
    await this.mirrorCardToUnified(card)
    // Also create an event for provenance in unified DB
    try {
      const db = await this.ensureUnifiedDb()
      if (db !== null) db.addEvent({ type: 'knowledge_write', target: 'knowledge', payload: { action: 'add', id: card.id, title } })
    } catch {}
    return {
      success: true,
      card,
      count: this.cards.length,
      charCount: this.charCount(),
      message: `Knowledge card saved (${String(this.cards.length)}/${String(this.options.maxCards)}).`,
    }
  }

  /** Update an existing card's title / summary / tags by id. */
  async updateCard(id: string, input: KnowledgeCardInput, origin: KnowledgeOrigin): Promise<KnowledgeResult> {
    const title = clean(input.title)
    const summary = clean(input.summary)
    if (title === '') return this.failure('title is required.')
    if (summary === '') return this.failure('summary is required.')
    const current = this.cardById(id)
    if (current === undefined) return this.failure(`No card with id ${id}.`)

    const conflict = this.cards.find(card => card.id !== id && sameTitle(card.title, title))
    if (conflict !== undefined) {
      return this.failure(`Another card already uses the title "${conflict.title}".`)
    }

    const updated: KnowledgeCard = {
      ...current,
      title,
      summary,
      tags: this.normalizeTags(input.tags),
      updatedAt: new Date().toISOString(),
    }
    await this.commit(
      this.cards.map(card => card.id === id ? updated : card),
      origin,
      'updated',
      title,
      id,
    )
    return {
      success: true,
      card: updated,
      count: this.cards.length,
      charCount: this.charCount(),
      message: 'Knowledge card updated.',
    }
  }

  /** Delete one card by id. */
  async deleteCard(id: string, origin: KnowledgeOrigin): Promise<KnowledgeResult> {
    const current = this.cardById(id)
    if (current === undefined) return this.failure(`No card with id ${id}.`)
    await this.commit(
      this.cards.filter(card => card.id !== id),
      origin,
      'deleted',
      current.title,
      id,
    )
    await this.mirrorDeleteToUnified(id)
    try {
      const db = await this.ensureUnifiedDb()
      if (db !== null) db.addEvent({ type: 'knowledge_write', target: 'knowledge', payload: { action: 'delete', id } })
    } catch {}
    return {
      success: true,
      count: this.cards.length,
      charCount: this.charCount(),
      message: 'Knowledge card deleted.',
    }
  }

  /** Normalize untrusted tags against the per-card budget. */
  private normalizeTags(value: readonly string[] | undefined): string[] {
    const tags: string[] = []
    for (const raw of value ?? []) {
      const tag = clean(raw)
      if (tag === '') continue
      tags.push(tag.slice(0, this.options.tagCharLimit))
      if (tags.length >= this.options.maxTags) break
    }
    return tags
  }

  /** Persist the next card list atomically and refresh the in-memory state. */
  private async commit(next: KnowledgeCard[], origin: KnowledgeOrigin, outcome: string, title: string, id?: string): Promise<void> {
    const previous = this.cards
    this.cards = next
    const document: KnowledgeDocument = { version: 1, cards: next }
    const serialized = `${JSON.stringify(document, null, 2)}\n`
    const path = join(this.dir, KNOWLEDGE_FILE)
    // Chain the file write: each commit carries the state captured at ITS
    // commit time, so serializing keeps the on-disk file converged with the
    // latest in-memory state even under concurrent writers.
    const writeTask = this.writeQueue.catch(() => {}).then(async () => {
      await writeFileAtomic(path, serialized, { mode: 0o600, dirMode: 0o700 })
    })
    this.writeQueue = writeTask.catch(() => {})
    try {
      await writeTask
    } catch (error) {
      // A failed durable write must not report a card that only exists in RAM.
      if (this.cards === next) this.cards = previous
      throw error
    }
    await this.audit({ time: new Date().toISOString(), origin, outcome, title, ...(id === undefined ? {} : { id }) })
  }

  private failure(error: string): KnowledgeResult {
    return {
      success: false,
      count: this.cards.length,
      charCount: this.charCount(),
      error,
    }
  }

  private async audit(record: AuditRecord): Promise<void> {
    try {
      const path = join(this.dir, AUDIT_FILE)
      await mkdir(this.dir, { recursive: true })
      const handle = await open(path, 'a')
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      } finally {
        await handle.close()
      }
    } catch {
      // Audit is best-effort and must never fail the write path it describes.
    }
  }

  private async readRaw(path: string): Promise<{ text: string, readFailed: boolean }> {
    try {
      const buffer = await readFile(path)
      try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), readFailed: false }
      } catch {
        return { text: '', readFailed: true }
      }
    } catch (error) {
      if (isEnoent(error)) return { text: '', readFailed: false }
      return { text: '', readFailed: true }
    }
  }
}

// ---------------------------------------------------------------------------
// /distill — LLM distillation of the current session into structured cards
// ---------------------------------------------------------------------------

/** Curation prompt for the structured-B distill output. */
const DISTILL_SYSTEM_PROMPT = [
  'You are the knowledge curator for a coding assistant. Distill the conversation digest into durable, structured knowledge cards.',
  'A knowledge card is a small structured record with a title, a one-paragraph summary, and tags.',
  'CAPTURE only facts worth remembering across sessions: decisions, architecture facts, user preferences, project constraints, reusable recipes, and corrections the user cared about.',
  'NEVER capture: trivial facts, raw data dumps, transient failures, resolved one-off errors, unverified dead ends, or anything already implied by the digest\'s existing knowledge context.',
  'Keep each title a concise noun phrase of at most 80 characters. Keep each summary a single factual paragraph of at most 600 characters, in the language the user writes in. Use at most 8 tags per card, each a short lowercase keyword of at most 24 characters.',
  'If nothing meets the bar, reply with exactly: Nothing to save.',
  'Otherwise reply with ONLY strict JSON and nothing else: {"cards":[{"title":"...","summary":"...","tags":["..."]}]}',
].join('\n')

const DISTILL_USER_PREFIX = [
  'Conversation digest (most recent turns last). Distill knowledge cards from this digest only.',
  '',
].join('\n')

interface DistillCard {
  readonly title: string
  readonly summary: string
  readonly tags: string[]
}

/** Parse the distill output: exact "Nothing to save." or a strict cards JSON. */
export function parseDistillOutput(text: string): DistillCard[] {
  const trimmed = text.trim()
  if (/^Nothing to save\.?$/i.test(trimmed)) return []
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error(`knowledge distill produced unparsable output: ${trimmed.slice(0, 200)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown
  } catch (error) {
    throw new Error(`knowledge distill produced invalid JSON: ${String(error)}`)
  }
  const record = parsed as { cards?: unknown }
  if (!Array.isArray(record.cards)) return []
  const cards: DistillCard[] = []
  for (const item of record.cards) {
    if (item === null || typeof item !== 'object') continue
    const card = item as Record<string, unknown>
    const title = typeof card.title === 'string' ? card.title.trim().slice(0, DISTILL_TITLE_LIMIT) : ''
    const summary = typeof card.summary === 'string' ? card.summary.trim().slice(0, DISTILL_SUMMARY_LIMIT) : ''
    if (title === '' || summary === '') continue
    const tags: string[] = []
    if (Array.isArray(card.tags)) {
      for (const tag of card.tags) {
        if (typeof tag !== 'string') continue
        const value = tag.trim().slice(0, DISTILL_TAG_LIMIT)
        if (value === '') continue
        tags.push(value)
        if (tags.length >= DISTILL_MAX_TAGS) break
      }
    }
    cards.push({ title, summary, tags })
    if (cards.length >= MAX_DISTILL_CARDS) break
  }
  return cards
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

/**
 * Run one bounded distillation of the given agent's session into knowledge
 * cards. Detached from the turn (the command handler awaits it, but the LLM
 * call never enters the session log because no sessionId is stamped).
 * Returns the accepted card titles.
 */
export async function distillSession(
  ctx: Context,
  store: KnowledgeStore,
  agent: Agent,
  signal: AbortSignal,
  maxDigestChars = 8_000,
  timeoutMs = 60_000,
): Promise<{ titles: string[], message: string }> {
  const digest = extractReviewDigest(agent, maxDigestChars)
  if (digest === '') {
    return { titles: [], message: 'This session has no distillable content yet.' }
  }
  const provider = agent.options.provider
  const model = agent.options.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    return { titles: [], message: 'No model route is available for this session; nothing was distilled.' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`knowledge distill timed out after ${String(timeoutMs)}ms`))
  }, timeoutMs)
  const onAbort = (): void => controller.abort(signal.reason instanceof Error ? signal.reason : new Error('distill aborted'))
  if (signal.aborted) controller.abort(signal.reason instanceof Error ? signal.reason : new Error('distill aborted'))
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'text', text: DISTILL_USER_PREFIX + digest }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-desktop-knowledge' },
    })]
    const options: GenerateOptions = {
      provider,
      model,
      messages,
      system: DISTILL_SYSTEM_PROMPT,
      maxTokens: 1_024,
      signal: controller.signal,
    }
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error') throw new Error(finish.failure.message)
    const cards = parseDistillOutput(textOfBlocks(assembler.blocks()))
    if (cards.length === 0) {
      return { titles: [], message: 'Nothing to save — the session did not surface durable knowledge.' }
    }
    const titles: string[] = []
    for (const card of cards) {
      const result = await store.addCard(card, 'distill')
      if (result.success && result.card !== undefined) titles.push(result.card.title)
    }
    return {
      titles,
      message: titles.length === 0
        ? 'No new cards were saved (all distilled facts already exist).'
        : `Distilled ${String(titles.length)} knowledge card(s): ${titles.join('、')}`,
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// Plugin apply + commands
// ---------------------------------------------------------------------------

/**
 * Register the knowledge store, the HTTP routes (bridging the harness
 * auto-retrieval and the panel), the `/distill` command (沉淀当前会话为知识卡),
 * and the `/knowledge` status command.
 */
export function apply(ctx: Context, config: Config): void {
  const store = new KnowledgeStore(join(ctx.desktopProfiles.current.dir, 'knowledge'), config)

  if (config.enabled) {
    ctx.inject(['webServer'], (hostCtx: Context) => {
      const host = hostCtx as unknown as {
        webServer: { register(route: { kind: 'exact' | 'prefix', path: string, handler: (request: unknown, response: unknown) => void | Promise<void> }): () => void }
        effect(callback: () => () => void, label: string): void
      }
      host.effect(() => mountKnowledgeRoutes(host, store, config), 'dsh-plugin-desktop: knowledge http routes')
    })
  }

  ctx.effect(async () => {
    try {
      await store.loadFromDisk()
    } catch (error) {
      ctx.logger.warn('dsh-plugin-desktop: knowledge store failed to load; continuing with an empty store: %s', String(error))
    }

    const disposers: Array<() => void> = []
    if (config.enabled) {
      // /distill — 沉淀当前会话为结构化知识卡（用户触发的一次性蒸馏）。
      try {
        disposers.push(ctx.commands.register({
          name: 'distill',
          description: '沉淀当前会话为结构化知识卡（distill the session into knowledge cards）',
          input: { hint: '[-n <maxDigestChars>]' },
          handler: (invocation: CommandInvocation) => handleDistillCommand(ctx, store, invocation),
        }))
      } catch (error) {
        ctx.logger.warn('dsh-plugin-desktop: could not register /distill command: %s', String(error))
      }
      try {
        disposers.push(ctx.commands.register({
          name: 'knowledge',
          description: '查看知识卡库状态（knowledge store status）',
          input: { hint: 'search <query> | list' },
          handler: (invocation: CommandInvocation) => handleKnowledgeCommand(store, config, invocation.rawInput),
        }))
      } catch (error) {
        ctx.logger.warn('dsh-plugin-desktop: could not register /knowledge command: %s', String(error))
      }
    }

    return () => {
      for (const dispose of [...disposers].reverse()) dispose()
    }
  }, 'dsh-plugin-desktop: structured knowledge store')
}

async function handleDistillCommand(ctx: Context, store: KnowledgeStore, invocation: CommandInvocation): Promise<CommandResult> {
  const raw = invocation.rawInput.trim()
  let maxDigestChars = 8_000
  const match = /^-n\s+(\d+)/u.exec(raw)
  if (match?.[1] !== undefined) {
    maxDigestChars = Math.max(500, Math.min(Number.parseInt(match[1], 10), 16_000))
  }
  try {
    const result = await distillSession(ctx, store, invocation.agent, invocation.signal, maxDigestChars)
    const text = result.titles.length === 0
      ? result.message
      : `${result.message}\n\n知识卡已保存至知识库，可通过 /knowledge 查看；后续会话将自动检索相关内容。`
    return { kind: 'success', text }
  } catch (error) {
    ctx.logger.warn('dsh-plugin-desktop: /distill failed: %s', String(error))
    return { kind: 'error', text: `蒸馏失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

function handleKnowledgeCommand(store: KnowledgeStore, config: Config, rawInput: string): Promise<CommandResult> {
  const trimmed = rawInput.trim()
  const space = trimmed.search(/\s/u)
  const verb = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
  const argument = space === -1 ? '' : trimmed.slice(space).trim()

  if (verb === 'search') {
    if (argument === '') return Promise.resolve({ kind: 'error', text: 'usage: /knowledge search <query>' })
    const cards = store.search(argument, 8)
    if (cards.length === 0) return Promise.resolve({ kind: 'success', text: `no cards matched '${argument}'` })
    const lines = cards.map(card => `# ${card.title}\n  ${card.summary}\n  tags: ${card.tags.join(', ') || '(none)'}`)
    return Promise.resolve({ kind: 'success', text: lines.join('\n\n') })
  }
  if (verb === 'list') {
    const cards = store.allCards()
    if (cards.length === 0) return Promise.resolve({ kind: 'success', text: 'knowledge store is empty' })
    const lines = cards.map(card => `# ${card.title}  [${card.tags.join(', ') || '无标签'}]`)
    return Promise.resolve({ kind: 'success', text: lines.join('\n') })
  }

  const cards = store.allCards()
  const charCount = store.charCount()
  const header = `KNOWLEDGE CARDS [${String(cards.length)}/${String(config.maxCards)} cards, ${String(charCount)} chars]`
  const body = cards.length === 0
    ? '(empty) — run /distill to distill the current session, or let the model save cards with the knowledge tool'
    : cards.map((card, index) => `${String(index + 1)}. ${card.title}  [${card.tags.join(', ') || '无标签'}]`).join('\n')
  return Promise.resolve({
    kind: 'success',
    text: `${header}\n${body}\n\ndistill: /distill · search: /knowledge search <query> · list: /knowledge list`,
  })
}

// ---------------------------------------------------------------------------
// Auto-detect complex problem solving / bug fixes in memory → knowledge card
// ---------------------------------------------------------------------------

/** Patterns that indicate a bug fix or complex problem was solved. */
const PROBLEM_SOLVED_PATTERNS: ReadonlyArray<{ readonly regex: RegExp, readonly tag: string, readonly label: string }> = [
  { regex: /bug\s*(fix|修复|resolved|solved)/i, tag: 'bug-fix', label: 'Bug 修复' },
  { regex: /(fix|修复|resolved|solved)\s*(bug|issue|问题|错误)/i, tag: 'bug-fix', label: 'Bug 修复' },
  { regex: /(问题|issue|problem|bug)\s*(已|was|is)?\s*(解决|修复|fixed|solved|resolved)/i, tag: 'bug-fix', label: '问题解决' },
  { regex: /(learned|discovered|found|发现|了解到|认识到)\s*(that|:|：)?/i, tag: 'learning', label: '经验教训' },
  { regex: /(solution|workaround|方案|解决方案|方法)\s*[:：]?\s*/i, tag: 'solution', label: '解决方案' },
  { regex: /(root\s*cause|根本原因|根因)\s*[:：]?\s*/i, tag: 'root-cause', label: '根因分析' },
  { regex: /(lesson|takeaway|经验|教训|总结)\s*[:：]?\s*/i, tag: 'lesson', label: '经验总结' },
  { regex: /(chose|decided|决定|选择|采用)\s*(to|使用|用|采用)?/i, tag: 'decision', label: '技术决策' },
  { regex: /(architecture|架构|设计模式|design\s*pattern)/i, tag: 'architecture', label: '架构设计' },
  { regex: /(配置|config|setup|部署|deploy)\s*[:：]?\s*/i, tag: 'config', label: '配置部署' },
]

/** Extract a concise title from a memory entry (first sentence or 60 chars). */
function extractTitle(entry: string): string {
  const clean = entry.replace(/^[•\-\*\d.]+\s*/u, '').trim()
  const firstSentence = clean.split(/[。.!！\n]/u)[0]?.trim() ?? clean
  return firstSentence.length > 60 ? firstSentence.slice(0, 57) + '...' : firstSentence
}

/** Extract tags from a memory entry based on detected patterns. */
function extractTags(entry: string): string[] {
  const tags: string[] = []
  for (const { regex, tag } of PROBLEM_SOLVED_PATTERNS) {
    if (regex.test(entry) && !tags.includes(tag)) {
      tags.push(tag)
      if (tags.length >= 3) break
    }
  }
  return tags
}

/**
 * Analyze a memory entry and determine if it represents a complex problem
 * solving event or bug fix worth distilling into a knowledge card.
 *
 * Returns null if the entry doesn't qualify, or a card input if it does.
 */
export function analyzeMemoryForKnowledge(entry: string): KnowledgeCardInput | null {
  if (entry.length < 30) return null  // Too short to be meaningful

  const matchedPatterns = PROBLEM_SOLVED_PATTERNS.filter(({ regex }) => regex.test(entry))
  if (matchedPatterns.length === 0) return null

  const title = extractTitle(entry)
  if (title.length < 10) return null

  const tags = extractTags(entry)
  const summary = entry.length > 500 ? entry.slice(0, 497) + '...' : entry

  return { title, summary, tags }
}

/**
 * Check a batch of memory operations and auto-create knowledge cards for
 * entries that match complex problem-solving patterns.
 *
 * This is designed to be called after a successful memory write.
 * Returns the titles of any cards created.
 */
export async function autoKnowledgeFromMemory(
  store: KnowledgeStore,
  operations: ReadonlyArray<{ readonly action: string, readonly content?: string }>,
): Promise<string[]> {
  const titles: string[] = []
  for (const op of operations) {
    if (op.action !== 'add' && op.action !== 'replace') continue
    const content = typeof op.content === 'string' ? op.content.trim() : ''
    if (content === '') continue
    const input = analyzeMemoryForKnowledge(content)
    if (input === null) continue
    const result = await store.addCard(input, 'model')
    if (result.success && result.card !== undefined) {
      titles.push(result.card.title)
    }
  }
  return titles
}
