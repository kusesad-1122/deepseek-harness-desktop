/**
 * Host HTTP routes bridging the browser memory settings panel to the live
 * MemoryStore. Read-only state is a GET; every mutation is a same-origin POST
 * with a 4 KiB body cap (same discipline as dsh-market's /dsh-market routes).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MemoryReviewer } from './memory-review.ts'
import type { Config, MemoryStore, MemoryTarget } from './memory.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

interface MemoryHost {
  readonly webServer: WebServerService
  effect(callback: () => () => void, label: string): void
}

export const MEMORY_STATE_ROUTE = '/dsh-desktop/memory/state'
export const MEMORY_APPROVE_ROUTE = '/dsh-desktop/memory/approve'
export const MEMORY_REJECT_ROUTE = '/dsh-desktop/memory/reject'
export const MEMORY_APPROVAL_ROUTE = '/dsh-desktop/memory/approval'
export const MEMORY_WRITE_ROUTE = '/dsh-desktop/memory/write'

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

function targetView(store: MemoryStore, target: MemoryTarget, limit: number) {
  return {
    target,
    charCount: store.charCount(target),
    charLimit: limit,
    entries: store.currentEntries(target),
  }
}

async function buildState(store: MemoryStore, reviewer: MemoryReviewer, config: Config): Promise<unknown> {
  const pending = await store.listPending()
  const review = reviewer.status()
  return {
    version: 6, // panel contract version, bumped with breaking shape changes
    approval: store.approval,
    pending,
    targets: [
      targetView(store, 'memory', config.memoryCharLimit),
      targetView(store, 'user', config.userCharLimit),
    ],
    review: {
      enabled: config.reviewEnabled,
      interval: config.reviewInterval,
      lastReviewedSecondsAgo: reviewer.lastReviewedSecondsAgo(),
      ...review,
    },
  }
}

/**
 * Mount every memory route. Mutations require a same-origin Origin header and
 * re-check the pending id shape before touching the filesystem.
 */
export function mountMemoryRoutes(host: MemoryHost, store: MemoryStore, reviewer: MemoryReviewer, config: Config): () => void {
  const disposers: Array<() => void> = [mountMemoryMutationRoutes(host, store)]
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: MEMORY_STATE_ROUTE,
    handler: async (_request, response) => {
      sendJson(response, 200, await buildState(store, reviewer, config))
    },
  }))
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: MEMORY_WRITE_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      try {
        const body = await readJsonBody(request) as { target?: unknown, operations?: unknown, origin?: unknown }
        const target = body.target
        if (target !== 'memory' && target !== 'user') return sendJson(response, 400, { error: 'target must be memory or user' })
        const origin = body.origin === 'review' ? 'review' as const : 'foreground' as const
        if (!Array.isArray(body.operations) || body.operations.length === 0) return sendJson(response, 400, { error: 'operations required' })
        const operations = body.operations.map((operation) => {
          const op = (operation ?? {}) as Record<string, unknown>
          const action = op.action
          if (action !== 'add' && action !== 'replace' && action !== 'remove') throw new Error('action must be add, replace, or remove')
          return {
            action,
            ...(typeof op.content === 'string' && op.content !== '' ? { content: op.content } : {}),
            ...(typeof op.oldText === 'string' && op.oldText !== '' ? { oldText: op.oldText } : {}),
          }
        }) as Parameters<typeof store.applyOperations>[1]
        sendJson(response, 200, await store.applyOperations(target, operations, { origin }))
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      }
    },
  }))
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}

export function mountMemoryMutationRoutes(host: MemoryHost, store: MemoryStore): () => void {
  const disposers: Array<() => void> = []
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: MEMORY_APPROVE_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      try {
        const body = await readJsonBody(request) as { id?: unknown }
        if (typeof body.id !== 'string') return sendJson(response, 400, { error: 'id required' })
        const result = await store.approvePending(body.id)
        if (result === null) return sendJson(response, 404, { error: 'pending write not found' })
        sendJson(response, 200, result)
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      }
    },
  }))
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: MEMORY_REJECT_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      try {
        const body = await readJsonBody(request) as { id?: unknown }
        if (typeof body.id !== 'string') return sendJson(response, 400, { error: 'id required' })
        const removed = await store.rejectPending(body.id)
        sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: 'pending write not found' })
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      }
    },
  }))
  disposers.push(host.webServer.register({
    kind: 'exact',
    path: MEMORY_APPROVAL_ROUTE,
    handler: async (request, response) => {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'cross-origin rejected' })
      try {
        const body = await readJsonBody(request) as { enabled?: unknown }
        if (typeof body.enabled !== 'boolean') return sendJson(response, 400, { error: 'enabled must be a boolean' })
        await store.setApproval(body.enabled)
        sendJson(response, 200, { ok: true, approval: store.approval })
      } catch (error) {
        sendJson(response, 400, { error: String(error) })
      }
    },
  }))
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}
