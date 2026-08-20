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

const DAILY_NEWS_RSS_URL = 'https://news.google.com/rss/search?q=AI+%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD+%E5%A4%A7%E6%A8%A1%E5%9E%8B&hl=zh-CN&gl=CN&ceid=CN:zh-Hans'
const DAILY_NEWS_SOURCE_NAME = 'AI 每日热点'
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

/** Parse a Google News RSS feed into a DailyNewsFeed. */
export function parseDailyNewsRss(xml: string, limit = 10): DailyNewsFeed {
  const pubDate = xmlText(xml, 'lastBuildDate')
  const items: DailyNewsItem[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1]
    if (block === undefined) continue
    const title = xmlText(block, 'title')
    if (!title) continue
    const link = xmlText(block, 'link')
    const pub = xmlText(block, 'pubDate')
    const cover = xmlAttr(block, 'media:content', 'url')
    items.push({
      id: String(items.length + 1),
      title,
      ...(link ? { url: link } : {}),
      ...(cover ? { cover } : {}),
      publishedAt: new Date(pub || Date.now()).toISOString(),
    })
  }
  if (items.length === 0) throw new Error('AI news RSS returned no headlines')
  return { date: pubDate || new Date().toISOString(), source: DAILY_NEWS_SOURCE_NAME, sourceUrl: 'https://news.google.com/search?q=AI+artificial+intelligence&hl=zh-CN', items }
}

/** Load and cache the fixed daily-hot-news feed; stale cache survives a transient source failure. */
export async function loadDailyNews(forceRefresh = false): Promise<DailyNewsFeed> {
  const now = Date.now()
  if (!forceRefresh && dailyNewsCache !== undefined && dailyNewsCache.expiresAt > now) {
    return dailyNewsCache.feed
  }
  try {
    const response = await fetch(DAILY_NEWS_RSS_URL, {
      headers: { accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`AI news source returned ${String(response.status)}`)
    const feed = parseDailyNewsRss(await response.text())
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
