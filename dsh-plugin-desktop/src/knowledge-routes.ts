/**
 * Host HTTP routes bridging the knowledge panel and the harness-side
 * auto-retrieval to the live KnowledgeStore. Reads are GETs; every mutation
 * is a same-origin POST with a 4 KiB body cap (same discipline as
 * `memory-routes.ts` and dsh-market routes).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config, KnowledgeStore } from './knowledge.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

interface KnowledgeHost {
  readonly webServer: WebServerService
  effect(callback: () => () => void, label: string): void
}

export const KNOWLEDGE_STATE_ROUTE = '/dsh-desktop/knowledge/state'
export const KNOWLEDGE_SEARCH_ROUTE = '/dsh-desktop/knowledge/search'
export const KNOWLEDGE_RETRIEVE_ROUTE = '/dsh-desktop/knowledge/retrieve'
export const KNOWLEDGE_CARDS_ROUTE = '/dsh-desktop/knowledge/cards'
export const KNOWLEDGE_UPDATE_ROUTE = '/dsh-desktop/knowledge/cards/update'
export const KNOWLEDGE_DELETE_ROUTE = '/dsh-desktop/knowledge/cards/delete'
export const DAILY_NEWS_ROUTE = '/dsh-desktop/news/daily'
export const LEGACY_KNOWLEDGE_NEWS_ROUTE = '/dsh-desktop/knowledge/news'
export const WORKBUDDY_EXPERTS_ROUTE = '/dsh-desktop/experts/list'
export const WORKBUDDY_EXPERT_AVATAR_ROUTE = '/dsh-desktop/experts/avatar'

// Primary: Google News RSS (may be blocked in mainland China)
const DAILY_NEWS_PRIMARY_URL = 'https://news.google.com/rss/search?q=AI+%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD+%E5%A4%A7%E6%A8%A1%E5%9E%8B&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'
const DAILY_NEWS_PRIMARY_SOURCE = 'Google News'
const DAILY_NEWS_PRIMARY_SOURCE_URL = 'https://news.google.com/search?q=AI+artificial+intelligence&hl=zh-CN'

// Fallback: 36kr RSS (accessible in mainland China)
const DAILY_NEWS_FALLBACK_URL = 'https://36kr.com/feed'
const DAILY_NEWS_FALLBACK_SOURCE = '36氪'
const DAILY_NEWS_FALLBACK_SOURCE_URL = 'https://36kr.com/'

const DAILY_NEWS_AI_KEYWORDS = ['AI', '人工智能', '大模型', 'GPT', 'LLM', '深度学习', '机器学习', 'OpenAI', '智能', '算法', '芯片', '机器人', '自动驾驶', 'AIGC']
const DAILY_NEWS_CACHE_MS = 15 * 60 * 1000

export interface DailyNewsItem {
  readonly id: string
  readonly title: string
  readonly url?: string
  readonly cover?: string
  readonly publishedAt: string
}

export interface DailyNewsFeed {
  readonly date: string
  readonly source: string
  readonly sourceUrl: string
  readonly items: readonly DailyNewsItem[]
}

export type DailyNewsLoader = (forceRefresh: boolean) => Promise<DailyNewsFeed>

let dailyNewsCache: { readonly expiresAt: number, readonly feed: DailyNewsFeed } | undefined

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 4096) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Parse one bounded non-negative integer query parameter. */
function intParam(url: URL, name: string, fallback: number, max: number): number {
  const value = url.searchParams.get(name)
  if (value === null || value === '') return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

/** Normalize an untrusted card input body into store inputs. */
function normalizeCardInput(body: unknown): { title: string, summary: string, tags: string[] } {
  const record = (body ?? {}) as Record<string, unknown>
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
  const tags: string[] = []
  if (Array.isArray(record.tags)) {
    for (const tag of record.tags) {
      if (typeof tag !== 'string') continue
      const value = tag.trim()
      if (value !== '') tags.push(value)
    }
  }
  return { title, summary, tags }
}

/** Extract text content from an XML element by tag name. */
function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>'))
  return m?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? ''
}

/** Extract an attribute value from the first matching tag. */
function xmlAttr(xml: string, tag: string, attr: string): string {
  const m = xml.match(new RegExp('<' + tag + '[^>]*?' + attr + '="([^"]*)"', 's'))
  return m?.[1] ?? ''
}

/** Check if a headline is related to AI topics. */
function isAiRelated(title: string): boolean {
  const lower = title.toLowerCase()
  return DAILY_NEWS_AI_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))
}

/** Parse a generic RSS feed into a DailyNewsFeed. */
export function parseDailyNewsRss(xml: string, source: string, sourceUrl: string, filterAi = false, limit = 10): DailyNewsFeed {
  const pubDate = xmlText(xml, 'lastBuildDate') || xmlText(xml, 'pubDate')
  const items: DailyNewsItem[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit * 3) {
    const block = match[1]
    if (block === undefined) continue
    const title = xmlText(block, 'title')
    if (!title) continue
    if (filterAi && !isAiRelated(title)) continue
    const link = xmlText(block, 'link')
    const pub = xmlText(block, 'pubDate')
    const cover = xmlAttr(block, 'media:content', 'url') || xmlAttr(block, 'media:thumbnail', 'url')
    items.push({
      id: String(items.length + 1),
      title,
      ...(link ? { url: link } : {}),
      ...(cover ? { cover } : {}),
      publishedAt: new Date(pub || Date.now()).toISOString(),
    })
    if (items.length >= limit) break
  }
  if (items.length === 0) throw new Error(`RSS from ${source} returned no headlines`)
  return { date: pubDate || new Date().toISOString(), source, sourceUrl, items }
}

/** Try to fetch and parse an RSS feed; returns null on failure. */
async function tryFetchRss(url: string, source: string, sourceUrl: string, filterAi: boolean, timeoutMs: number): Promise<DailyNewsFeed | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return parseDailyNewsRss(await response.text(), source, sourceUrl, filterAi)
  } catch {
    return null
  }
}

/** Load and cache the daily-hot-news feed with automatic fallback. */
export async function loadDailyNews(forceRefresh = false): Promise<DailyNewsFeed> {
  const now = Date.now()
  if (!forceRefresh && dailyNewsCache !== undefined && dailyNewsCache.expiresAt > now) {
    return dailyNewsCache.feed
  }

  // Try primary source (Google News) — already AI-focused, no keyword filter needed
  const primary = await tryFetchRss(DAILY_NEWS_PRIMARY_URL, DAILY_NEWS_PRIMARY_SOURCE, DAILY_NEWS_PRIMARY_SOURCE_URL, false, 8_000)
  if (primary !== null) {
    dailyNewsCache = { expiresAt: now + DAILY_NEWS_CACHE_MS, feed: primary }
    return primary
  }

  // Fallback: 36kr — need AI keyword filter since it covers all tech
  const fallback = await tryFetchRss(DAILY_NEWS_FALLBACK_URL, DAILY_NEWS_FALLBACK_SOURCE, DAILY_NEWS_FALLBACK_SOURCE_URL, true, 8_000)
  if (fallback !== null) {
    dailyNewsCache = { expiresAt: now + DAILY_NEWS_CACHE_MS, feed: fallback }
    return fallback
  }

  // Both failed — return stale cache if available
  if (dailyNewsCache !== undefined) return dailyNewsCache.feed
  throw new Error('All news sources are unavailable')
}
// ── WorkBuddy expert directory scanning ──────────────────────────────────

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface WorkBuddyExpertItem {
  readonly id: string
  readonly name: string
  readonly displayName: Record<string, string>
  readonly profession: Record<string, string>
  readonly description: Record<string, string>
  readonly marketplace: string
  readonly expertType: string
  readonly hasAvatar: boolean
  readonly avatarRoute: string
  readonly tags: Array<Record<string, string>>
  readonly categoryId?: string
}

let expertsCache: { readonly expiresAt: number, readonly experts: readonly WorkBuddyExpertItem[] } | undefined
const EXPERTS_CACHE_MS = 5 * 60 * 1000

/** Scan one directory level for plugin dirs containing .codebuddy-plugin/plugin.json */
function scanPluginDirs(baseDir: string, marketplace: string): WorkBuddyExpertItem[] {
  const results: WorkBuddyExpertItem[] = []
  if (!existsSync(baseDir)) return results
  let entries: string[]
  try { entries = readdirSync(baseDir) } catch { return results }
  for (const entry of entries) {
    const pluginDir = join(baseDir, entry)
    const jsonPath = join(pluginDir, '.codebuddy-plugin', 'plugin.json')
    if (!existsSync(jsonPath)) continue
    try {
      const raw = readFileSync(jsonPath, 'utf8')
      const json = JSON.parse(raw) as Record<string, unknown>
      const expertType = typeof json.expertType === 'string' ? json.expertType : ''
      if (expertType !== 'agent' && expertType !== 'team') continue
      const name = typeof json.name === 'string' ? json.name : entry
      const dn = (typeof json.displayName === 'object' && json.displayName !== null) ? json.displayName as Record<string, string> : { en: name, zh: name }
      const prof = (typeof json.profession === 'object' && json.profession !== null) ? json.profession as Record<string, string> : { en: '', zh: '' }
      const desc = (typeof json.displayDescription === 'object' && json.displayDescription !== null) ? json.displayDescription as Record<string, string> : (typeof json.description === 'string' ? { en: json.description, zh: json.description } : { en: '', zh: '' })
      const avatarRel = typeof json.avatar === 'string' ? json.avatar : ''
      const avatarFull = avatarRel !== '' ? join(pluginDir, avatarRel) : ''
      const hasAvatar = avatarFull !== '' && existsSync(avatarFull)
      const tagsRaw = Array.isArray(json.tags) ? json.tags : []
      const tags = tagsRaw.filter((t): t is Record<string, string> => typeof t === 'object' && t !== null)
      const categoryId = typeof json.categoryId === 'string' ? json.categoryId : undefined
      results.push({
        id: `${marketplace}/${name}`,
        name,
        displayName: dn,
        profession: prof,
        description: desc,
        marketplace,
        expertType,
        hasAvatar,
        avatarRoute: `${WORKBUDDY_EXPERT_AVATAR_ROUTE}?marketplace=${encodeURIComponent(marketplace)}&name=${encodeURIComponent(name)}`,
        tags,
        ...(categoryId !== undefined ? { categoryId } : {}),
      })
    } catch { /* skip malformed plugin.json */ }
  }
  return results
}

/** Scan ~/.workbuddy/plugins/marketplaces/ for all expert plugins. */
export function scanWorkBuddyExperts(forceRefresh = false): readonly WorkBuddyExpertItem[] {
  const now = Date.now()
  if (!forceRefresh && expertsCache !== undefined && expertsCache.expiresAt > now) return expertsCache.experts
  const wbRoot = resolve(homedir(), '.workbuddy', 'plugins', 'marketplaces')
  if (!existsSync(wbRoot)) return []
  const results: WorkBuddyExpertItem[] = []
  let marketplaces: string[]
  try { marketplaces = readdirSync(wbRoot) } catch { return [] }
  for (const mp of marketplaces) {
    if (mp.endsWith('.tmp') || mp.endsWith('.zip')) continue
    const mpDir = join(wbRoot, mp)
    let st: ReturnType<typeof statSync>
    try { st = statSync(mpDir) } catch { continue }
    if (!st.isDirectory()) continue
    // Scan plugins/, external_plugins/, builtin-plugins/ subdirectories
    for (const subDir of ['plugins', 'external_plugins', 'builtin-plugins']) {
      const scanDir = join(mpDir, subDir)
      results.push(...scanPluginDirs(scanDir, mp))
    }
  }
  expertsCache = { expiresAt: now + EXPERTS_CACHE_MS, experts: results }
  return results
}

/** Serve an expert avatar image. Returns the buffer and content-type, or null. */
export function getExpertAvatar(marketplace: string, name: string): { data: Buffer, mime: string } | null {
  const wbRoot = resolve(homedir(), '.workbuddy', 'plugins', 'marketplaces')
  for (const subDir of ['plugins', 'external_plugins', 'builtin-plugins']) {
    const pluginDir = join(wbRoot, marketplace, subDir, name)
    const jsonPath = join(pluginDir, '.codebuddy-plugin', 'plugin.json')
    if (!existsSync(jsonPath)) continue
    try {
      const json = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>
      const avatarRel = typeof json.avatar === 'string' ? json.avatar : ''
      if (avatarRel === '') continue
      const avatarPath = join(pluginDir, avatarRel)
      if (!existsSync(avatarPath)) continue
      const data = readFileSync(avatarPath)
      const ext = avatarPath.toLowerCase()
      const mime = ext.endsWith('.png') ? 'image/png' : ext.endsWith('.jpg') || ext.endsWith('.jpeg') ? 'image/jpeg' : ext.endsWith('.svg') ? 'image/svg+xml' : ext.endsWith('.webp') ? 'image/webp' : 'application/octet-stream'
      return { data, mime }
    } catch { /* skip */ }
  }
  return null
}

/**
 * Mount every knowledge route. Mutations require a same-origin Origin header.
 */
export function mountKnowledgeRoutes(
  host: KnowledgeHost,
  store: KnowledgeStore,
  config: Config,
  dailyNews: DailyNewsLoader = loadDailyNews,
): () => void {
  const disposers: Array<() => void> = []
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_STATE_ROUTE,
    handler: async (_request, response) => {
      const cards = store.allCards()
      sendJson(response, 200, {
        version: 1,
        enabled: config.enabled,
        autoRetrieval: config.autoRetrieval,
        retrieveTopK: config.retrieveTopK,
        maxCards: config.maxCards,
        count: store.count(),
        charCount: store.charCount(),
        cards,
      })
    },
  }))
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_SEARCH_ROUTE,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const query = (url.searchParams.get('q') ?? '').trim()
      if (query === '') return sendJson(response, 400, { error: 'q is required' })
      sendJson(response, 200, {
        cards: store.search(query, intParam(url, 'limit', 8, 20)),
      })
    },
  }))
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_RETRIEVE_ROUTE,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      sendJson(response, 200, {
        cards: store.retrieve(
          (url.searchParams.get('q') ?? '').trim(),
          intParam(url, 'top', config.retrieveTopK, 20),
        ),
      })
    },
  }))
  const handleDailyNews = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      sendJson(response, 200, await dailyNews(url.searchParams.get('refresh') === '1'))
    } catch (error) {
      sendJson(response, 502, { error: String(error) })
    }
  }
  for (const path of [DAILY_NEWS_ROUTE, LEGACY_KNOWLEDGE_NEWS_ROUTE]) {
    disposers.push(host.webServer.register({ kind: 'exact', path, handler: handleDailyNews }))
  }
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_CARDS_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      try {
        const body = await readJsonBody(request)
        const input = normalizeCardInput(body)
        if (input.title === '' || input.summary === '') {
          return sendJson(response, 400, { error: 'title and summary are required' })
        }
        const origin = (body as { source?: unknown }).source === 'distill' ? 'distill' as const : 'manual' as const
        sendJson(response, 200, await store.addCard(input, origin))
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      }
    },
  }))
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_UPDATE_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      try {
        const body = await readJsonBody(request) as { id?: unknown }
        if (typeof body.id !== 'string' || body.id === '') {
          return sendJson(response, 400, { error: 'id is required' })
        }
        const input = normalizeCardInput(body)
        if (input.title === '' || input.summary === '') {
          return sendJson(response, 400, { error: 'title and summary are required' })
        }
        sendJson(response, 200, await store.updateCard(body.id, input, 'manual'))
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      }
    },
  }))
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_DELETE_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      try {
        const body = await readJsonBody(request) as { id?: unknown }
        if (typeof body.id !== 'string' || body.id === '') {
          return sendJson(response, 400, { error: 'id is required' })
        }
        sendJson(response, 200, await store.deleteCard(body.id, 'manual'))
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      }
    },
  }))
  // ── WorkBuddy expert list ──────────────────────────────────────────────
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: WORKBUDDY_EXPERTS_ROUTE,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const force = url.searchParams.get('refresh') === '1'
      sendJson(response, 200, { experts: scanWorkBuddyExperts(force) })
    },
  }))

  // ── WorkBuddy expert avatar ────────────────────────────────────────────
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: WORKBUDDY_EXPERT_AVATAR_ROUTE,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const marketplace = (url.searchParams.get('marketplace') ?? '').trim()
      const name = (url.searchParams.get('name') ?? '').trim()
      if (marketplace === '' || name === '') {
        response.writeHead(400); response.end(); return
      }
      const avatar = getExpertAvatar(marketplace, name)
      if (avatar === null) {
        response.writeHead(404); response.end(); return
      }
      response.writeHead(200, {
        'content-type': avatar.mime,
        'cache-control': 'public, max-age=3600',
      })
      response.end(avatar.data)
    },
  }))

  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
