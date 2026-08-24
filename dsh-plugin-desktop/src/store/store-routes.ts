/**
 * Unified store HTTP routes (S2/S3): stats, candidate queue, graph, knowledge pages, document index/search.
 * All mutations are same-origin POST with 4 KiB cap, matching memory/knowledge routes discipline.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve, join } from 'node:path'
import { UnifiedDb, defaultUnifiedDbPath } from './unified-db.ts'
import { chunkText, indexFile, indexDirectory, buildKnowledgePages, buildRelations } from './document-indexer.ts'

export interface StoreHost {
  readonly webServer: {
    register(route: { kind: 'exact' | 'prefix', path: string, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> }): () => void
  }
  effect(callback: () => () => void, label: string): void
}

export const STORE_STATS_ROUTE = '/dsh-desktop/store/stats'
export const STORE_CANDIDATES_ROUTE = '/dsh-desktop/store/candidates'
export const STORE_CANDIDATE_APPROVE_ROUTE = '/dsh-desktop/store/candidates/approve'
export const STORE_CANDIDATE_REJECT_ROUTE = '/dsh-desktop/store/candidates/reject'
export const STORE_GRAPH_ROUTE = '/dsh-desktop/store/graph'
export const KNOWLEDGE_PAGES_ROUTE = '/dsh-desktop/knowledge/pages'
export const STORE_DOCUMENT_INDEX_ROUTE = '/dsh-desktop/store/document/index'
export const STORE_DOCUMENT_SEARCH_ROUTE = '/dsh-desktop/store/document/search'
export const STORE_DOCUMENT_CHUNKS_ROUTE = '/dsh-desktop/store/document/chunks'

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try { return new URL(origin).host === host } catch { return false }
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

function getUnifiedDb(profileDir: string): UnifiedDb | null {
  try {
    const dbPath = defaultUnifiedDbPath(profileDir)
    const db = new UnifiedDb(dbPath, { memoryCharLimit: 2200, userCharLimit: 1375, maxCards: 500 })
    db.open()
    return db
  } catch {
    return null
  }
}

export function mountStoreRoutes(host: StoreHost, profileDir: string): () => void {
  const disposers: Array<() => void> = []

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: STORE_STATS_ROUTE,
    handler: async (_request, response) => {
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 200, { events: 0, facts: 0, cards: 0, chunks: 0, pending: 0 })
      try {
        const stats = db.stats()
        sendJson(response, 200, { ...stats, pending: stats.candidatesPending })
      } catch (error) {
        sendJson(response, 500, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: STORE_CANDIDATES_ROUTE,
    handler: async (_request, response) => {
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 200, { candidates: [] })
      try {
        sendJson(response, 200, { candidates: db.listCandidates('pending') })
      } catch (error) {
        sendJson(response, 500, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: STORE_CANDIDATE_APPROVE_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 500, { error: 'unified store unavailable' })
      try {
        const body = await readJsonBody(request) as { id?: unknown }
        if (typeof body.id !== 'string' || body.id === '') return sendJson(response, 400, { error: 'id required' })
        const result = db.approveCandidate(body.id)
        // Project to files after approve
        try { await db.syncProjection(join(profileDir, 'memory')) } catch {}
        sendJson(response, 200, { ok: true, candidate: result.candidate, fact: result.fact })
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: STORE_CANDIDATE_REJECT_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 500, { error: 'unified store unavailable' })
      try {
        const body = await readJsonBody(request) as { id?: unknown }
        if (typeof body.id !== 'string' || body.id === '') return sendJson(response, 400, { error: 'id required' })
        const candidate = db.rejectCandidate(body.id)
        sendJson(response, 200, { ok: true, candidate })
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: STORE_GRAPH_ROUTE,
    handler: async (_request, response) => {
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 200, { nodes: [], edges: [] })
      try {
        const cards = db.listKnowledgeCards()
        const relations = buildRelations(cards.map(c => ({ id: c.id, tags: [...c.tags] })))
        // Persist derived relations (best-effort)
        for (const edge of relations.slice(0, 50)) {
          try { db.upsertRelation(edge.sourceId, edge.targetId, edge.type, edge.weight) } catch {}
        }
        const nodes = cards.map(c => ({ id: c.id, title: c.title, tags: c.tags }))
        sendJson(response, 200, { nodes, edges: relations, stored: db.listRelations() })
      } catch (error) {
        sendJson(response, 500, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: KNOWLEDGE_PAGES_ROUTE,
    handler: async (_request, response) => {
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 200, { pages: [] })
      try {
        const cards = db.listKnowledgeCards()
        const pages = buildKnowledgePages(cards.map(c => ({ id: c.id, title: c.title, tags: [...c.tags] })))
        sendJson(response, 200, { pages, total: cards.length })
      } catch (error) {
        sendJson(response, 500, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: STORE_DOCUMENT_INDEX_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 500, { error: 'unified store unavailable' })
      try {
        const body = await readJsonBody(request) as { path?: unknown, dir?: unknown, content?: unknown }
        if (typeof body.path === 'string' && body.path.trim() !== '') {
          // Single file index (content may be provided directly for testing)
          if (typeof body.content === 'string' && body.content.trim() !== '') {
            const text = body.content as string
            const hash = text.slice(0, 16)
            const chunks = chunkText(text)
            db.upsertDocumentChunks(body.path.trim(), hash, chunks)
            sendJson(response, 200, { ok: true, path: body.path.trim(), chunks: chunks.length })
          } else {
            const abs = resolve(body.path.trim())
            const result = await indexFile(db, abs, resolve(profileDir, '..'))
            sendJson(response, 200, { ok: true, ...result })
          }
        } else if (typeof body.dir === 'string' && body.dir.trim() !== '') {
          const result = await indexDirectory(db, resolve(body.dir.trim()))
          sendJson(response, 200, { ok: true, ...result })
        } else {
          sendJson(response, 400, { error: 'path or dir required' })
        }
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: STORE_DOCUMENT_SEARCH_ROUTE,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const q = (url.searchParams.get('q') ?? '').trim()
      if (q === '') return sendJson(response, 400, { error: 'q required' })
      const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') ?? '8', 10) || 8, 1), 20)
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 200, { chunks: [] })
      try {
        const chunks = db.searchDocumentChunks(q, limit)
        // Fallback to knowledge cards if no chunks
        if (chunks.length === 0) {
          const cards = db.searchKnowledgeCards(q, limit)
          sendJson(response, 200, { chunks, cards })
        } else {
          sendJson(response, 200, { chunks })
        }
      } catch (error) {
        sendJson(response, 500, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: STORE_DOCUMENT_CHUNKS_ROUTE,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = (url.searchParams.get('path') ?? '').trim()
      if (path === '') return sendJson(response, 400, { error: 'path required' })
      const db = getUnifiedDb(profileDir)
      if (db === null) return sendJson(response, 200, { chunks: [] })
      try {
        sendJson(response, 200, { chunks: db.getDocumentChunks(path) })
      } catch (error) {
        sendJson(response, 500, { error: String(error) })
      } finally {
        try { db.close() } catch {}
      }
    },
  }))

  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
