/**
 * Knowledge-store client contract for the left extended panel, matched to the
 * host routes in `src/knowledge-routes.ts`:
 *
 *   GET  /dsh-desktop/knowledge/state          → { version, enabled, autoRetrieval,
 *                                                 retrieveTopK, maxCards, count,
 *                                                 charCount, cards }
 *   GET  /dsh-desktop/knowledge/search?q=&limit= → { cards }
 *   POST /dsh-desktop/knowledge/cards          { title, summary, tags?, source? }
 *   POST /dsh-desktop/knowledge/cards/update   { id, title, summary, tags? }
 *   POST /dsh-desktop/knowledge/cards/delete   { id } → { success, message?, error? }
 *
 * The news feed is optional and forward-compatible: when the host has not
 * mounted `/dsh-desktop/knowledge/news` yet, the news section shows a neutral
 * hint instead of breaking the panel.
 */

export const KNOWLEDGE_STATE_ROUTE = '/dsh-desktop/knowledge/state'
export const KNOWLEDGE_SEARCH_ROUTE = '/dsh-desktop/knowledge/search'
export const KNOWLEDGE_RETRIEVE_ROUTE = '/dsh-desktop/knowledge/retrieve'
export const KNOWLEDGE_CARDS_ROUTE = '/dsh-desktop/knowledge/cards'
export const KNOWLEDGE_UPDATE_ROUTE = '/dsh-desktop/knowledge/cards/update'
export const KNOWLEDGE_DELETE_ROUTE = '/dsh-desktop/knowledge/cards/delete'
export const KNOWLEDGE_NEWS_ROUTE = '/dsh-desktop/knowledge/news'

/** Who created the card; mirrors the host KnowledgeOrigin. */
export type KnowledgeOrigin = 'manual' | 'distill' | 'model'

/** One knowledge card as served by the host store. */
export interface KnowledgeCardView {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[]
  readonly source: KnowledgeOrigin
  /** ISO timestamp of creation. */
  readonly createdAt: string
  /** ISO timestamp of the last update. */
  readonly updatedAt: string
}

/** Full knowledge state served by the host. */
export interface KnowledgeStateView {
  readonly version: number
  readonly enabled: boolean
  readonly autoRetrieval: boolean
  readonly retrieveTopK: number
  readonly maxCards: number
  readonly count: number
  readonly charCount: number
  readonly cards: KnowledgeCardView[]
}

/** One news item (optional host feed). */
export interface NewsItemView {
  readonly id: string
  readonly title: string
  readonly url?: string
  readonly summary?: string
  readonly publishedAt: string
}

/** @returns a bounded, human-friendly relative time label from an ISO timestamp or epoch ms. */
export function relativeTime(now: number, time: string | number): string {
  const then = typeof time === 'number' ? time : Date.parse(time)
  if (!Number.isFinite(then)) return '—'
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

async function getJson(route: string): Promise<unknown | null> {
  try {
    const response = await fetch(route, { cache: 'no-store' })
    if (!response.ok) return null
    return await response.json() as unknown
  } catch {
    return null
  }
}

/** Load the knowledge state; null when the host route is unavailable. */
export async function fetchKnowledgeState(): Promise<KnowledgeStateView | null> {
  const body = await getJson(KNOWLEDGE_STATE_ROUTE) as KnowledgeStateView | null
  if (body === null || !Array.isArray(body.cards)) return null
  return {
    ...body,
    cards: body.cards.filter(isKnowledgeCard),
  }
}

/** Delete one knowledge card; resolves true when the host confirmed. */
export async function deleteKnowledgeCard(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const response = await fetch(KNOWLEDGE_DELETE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await response.json().catch(() => ({})) as { success?: unknown, error?: unknown }
    if (!response.ok || body.success !== true) {
      const error = typeof body.error === 'string' ? body.error : undefined
      return error === undefined ? { ok: false } : { ok: false, error }
    }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** Load the news items; null when the host route is unavailable. */
export async function fetchNewsItems(): Promise<NewsItemView[] | null> {
  const body = await getJson(KNOWLEDGE_NEWS_ROUTE) as { items?: unknown } | null
  if (body === null || !Array.isArray(body.items)) return null
  return body.items.filter(isNewsItem)
}

function isKnowledgeCard(value: unknown): value is KnowledgeCardView {
  if (typeof value !== 'object' || value === null) return false
  const card = value as Record<string, unknown>
  return typeof card.id === 'string'
    && typeof card.title === 'string'
    && typeof card.summary === 'string'
    && typeof card.createdAt === 'string'
    && typeof card.updatedAt === 'string'
    && Array.isArray(card.tags)
}

function isNewsItem(value: unknown): value is NewsItemView {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.title === 'string'
}
