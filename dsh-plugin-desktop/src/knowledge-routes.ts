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
export const KNOWLEDGE_NEWS_ROUTE = '/dsh-desktop/knowledge/news'

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

/**
 * Mount every knowledge route. Mutations require a same-origin Origin header.
 */
export function mountKnowledgeRoutes(host: KnowledgeHost, store: KnowledgeStore, config: Config): () => void {
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
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_NEWS_ROUTE,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const limit = intParam(url, 'limit', 8, 20)
      const latest = store
        .allCards()
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
      const items = latest.map((card) => ({
        id: card.id,
        title: card.title,
        summary: card.summary,
        publishedAt: card.updatedAt,
      }))
      sendJson(response, 200, { items })
    },
  }))
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
