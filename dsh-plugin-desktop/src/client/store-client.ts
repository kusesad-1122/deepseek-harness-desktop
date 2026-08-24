/**
 * Unified store client for the extended panel (S2/S3):
 * stats, candidates, graph, knowledge pages, document search.
 */

export const STORE_STATS_ROUTE = '/dsh-desktop/store/stats'
export const STORE_CANDIDATES_ROUTE = '/dsh-desktop/store/candidates'
export const STORE_CANDIDATE_APPROVE_ROUTE = '/dsh-desktop/store/candidates/approve'
export const STORE_CANDIDATE_REJECT_ROUTE = '/dsh-desktop/store/candidates/reject'
export const STORE_GRAPH_ROUTE = '/dsh-desktop/store/graph'
export const KNOWLEDGE_PAGES_ROUTE = '/dsh-desktop/knowledge/pages'
export const STORE_DOCUMENT_SEARCH_ROUTE = '/dsh-desktop/store/document/search'
export const STORE_DOCUMENT_INDEX_ROUTE = '/dsh-desktop/store/document/index'

export interface StoreStatsView {
  readonly events: number
  readonly facts: number
  readonly cards: number
  readonly chunks: number
  readonly pending: number
  readonly relations?: number
}

export interface CandidateView {
  readonly id: string
  readonly target: string
  readonly content: string
  readonly status: string
  readonly createdAt: string
}

export interface GraphView {
  readonly nodes: Array<{ id: string, title: string, tags: readonly string[] }>
  readonly edges: Array<{ sourceId: string, targetId: string, type: string, weight: number }>
}

export interface KnowledgePageView {
  readonly id: string
  readonly title: string
  readonly cardIds: readonly string[]
  readonly tags: readonly string[]
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

export async function fetchStoreStats(): Promise<StoreStatsView | null> {
  return await getJson(STORE_STATS_ROUTE) as StoreStatsView | null
}

export async function fetchCandidates(): Promise<CandidateView[] | null> {
  const body = await getJson(STORE_CANDIDATES_ROUTE) as { candidates?: unknown } | null
  if (body === null || !Array.isArray(body.candidates)) return null
  return body.candidates as CandidateView[]
}

export async function approveCandidate(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const response = await fetch(STORE_CANDIDATE_APPROVE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await response.json().catch(() => ({})) as { ok?: unknown, error?: unknown }
    if (!response.ok) return { ok: false, error: typeof body.error === 'string' ? body.error : 'approve failed' }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export async function rejectCandidate(id: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const response = await fetch(STORE_CANDIDATE_REJECT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const body = await response.json().catch(() => ({})) as { ok?: unknown, error?: unknown }
    if (!response.ok) return { ok: false, error: typeof body.error === 'string' ? body.error : 'reject failed' }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export async function fetchGraph(): Promise<GraphView | null> {
  return await getJson(STORE_GRAPH_ROUTE) as GraphView | null
}

export async function fetchKnowledgePages(): Promise<{ pages: KnowledgePageView[], total: number } | null> {
  return await getJson(KNOWLEDGE_PAGES_ROUTE) as { pages: KnowledgePageView[], total: number } | null
}

export async function searchDocuments(query: string, limit = 8): Promise<{ chunks?: Array<{ content: string, path: string }>, cards?: unknown } | null> {
  const url = `${STORE_DOCUMENT_SEARCH_ROUTE}?q=${encodeURIComponent(query)}&limit=${String(limit)}`
  return await getJson(url) as { chunks?: Array<{ content: string, path: string }> } | null
}
