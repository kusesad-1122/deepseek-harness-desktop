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

const DAILY_NEWS_SOURCE_API = 'https://60s.viki.moe/v2/60s'
const DAILY_NEWS_SOURCE_NAME = '每天60秒读懂世界'
const DAILY_NEWS_CACHE_MS = 15 * 60 * 1000

export interface DailyNewsItem {
  readonly id: string
  readonly title: string
  readonly url?: string
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

/** Parse the bounded public daily-news response without trusting its fields. */
export function parseDailyNewsPayload(input: unknown): DailyNewsFeed {
  if (typeof input !== 'object' || input === null) throw new Error('daily news response is not an object')
  const root = input as Record<string, unknown>
  const data = root.data
  if (root.code !== 200 || typeof data !== 'object' || data === null) {
    throw new Error('daily news source did not return success')
  }
  const record = data as Record<string, unknown>
  const date = typeof record.date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(record.date)
    ? record.date
    : new Date().toISOString().slice(0, 10)
  const sourceUrl = typeof record.link === 'string' && record.link.startsWith('https://')
    ? record.link
    : 'https://github.com/vikiboss/60s'
  const publishedAt = `${date}T00:00:00.000Z`
  const news = Array.isArray(record.news)
    ? record.news.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 20)
    : []
  if (news.length === 0) throw new Error('daily news source returned no headlines')
  return {
    date,
    source: DAILY_NEWS_SOURCE_NAME,
    sourceUrl,
    items: news.map((title, index) => ({
      id: `${date}-${String(index + 1)}`,
      title: title.trim(),
      url: sourceUrl,
      publishedAt,
    })),
  }
}

/** Load and cache the fixed daily-hot-news feed; stale cache survives a transient source failure. */
export async function loadDailyNews(forceRefresh = false): Promise<DailyNewsFeed> {
  const now = Date.now()
  if (!forceRefresh && dailyNewsCache !== undefined && dailyNewsCache.expiresAt > now) {
    return dailyNewsCache.feed
  }
  try {
    const response = await fetch(DAILY_NEWS_SOURCE_API, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error(`daily news source returned ${String(response.status)}`)
    const feed = parseDailyNewsPayload(await response.json())
    dailyNewsCache = { expiresAt: now + DAILY_NEWS_CACHE_MS, feed }
    return feed
  } catch (error) {
    if (dailyNewsCache !== undefined) return dailyNewsCache.feed
    throw error
  }
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
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
