/**
 * Desktop extended workspace — boujoy-fused edition.
 *
 * Full-page workspace with a slim left nav rail:
 *   01 今日 focus  — 当前工作 + 下一步行动 + 待审批 + 沉淀按钮
 *   02 知识库      — 搜索 + 卡片网格 + 详情 + 删除 + 沉淀表单
 *   03 图谱        — 新闻卡片 + 宽幅知识图谱
 *   04 健康中心    — 知识/记忆健康检查（只读候选，不删除）
 *   05 阅读器      — 知识卡全文阅读 + 复制
 *   06 专家风格    — 本地风格选择
 *
 * Collapsed (`collapsed`) renders only the compact icon rail; expanding
 * shows the full-page workspace (nav 220px + page). All data comes from the
 * existing host routes (knowledge + memory state); nothing writes beyond the
 * knowledge card create/delete endpoints already exposed.
 */

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import {
  deleteKnowledgeCard, fetchKnowledgeState, relativeTime,
} from './knowledge-client.ts'
import type { KnowledgeCardView } from './knowledge-client.ts'
import {
  fetchStoreStats, fetchCandidates, approveCandidate, rejectCandidate,
  fetchGraph, fetchKnowledgePages, searchDocuments,
} from './store-client.ts'
import type { StoreStatsView, CandidateView, GraphView, KnowledgePageView } from './store-client.ts'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'

export interface ExtendedTranslate {
  (key: string): string
}

/** Minimal panel open/close control supplied by the hosting shell. */
export interface ExtendedLayoutControl {
  openExtended(): void
  toggleExtended(): void
}

export type ExtendedPanelUseSessions = (selector: (state: SessionListState) => SessionListState) => SessionListState

/** Business face provided to the extended panel registration. */
export interface ExtendedPanelInjected {
  t: ExtendedTranslate
  layout: ExtendedLayoutControl
  /** Open one session from the 对话 section. */
  openSession: (id: SessionId) => void
}

export interface ExtendedPanelProps extends ExtendedPanelInjected {
  collapsed: boolean
  width?: number
  useSessions: ExtendedPanelUseSessions
}

type PageId = 'today' | 'knowledge' | 'experts' | 'graph' | 'news' | 'health' | 'reader' | 'expert' | 'store'

interface NavItem {
  id: PageId
  icon: string
  label: string
}

const knowledgePollMs = 5_000
const NAV_WIDTH = 220
const NAV_RAIL_WIDTH = 56

const navItems: NavItem[] = [
  { id: 'today', icon: '🌅', label: '今日' },
  { id: 'knowledge', icon: '📇', label: '知识库' },
  { id: 'experts', icon: '🧑‍🏫', label: '专家' },
  { id: 'graph', icon: '🕸️', label: '图谱' },
  { id: 'news', icon: '📰', label: '每日热点' },
  { id: 'health', icon: '🩺', label: '健康中心' },
  { id: 'reader', icon: '📖', label: '阅读器' },
  { id: 'expert', icon: '🎯', label: '专家风格' },
  { id: 'store', icon: 'DB', label: '统一存储' },
]

const workspace: React.CSSProperties = {
  position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, zIndex: 1000,
  display: 'flex', overflow: 'hidden',
  background: 'var(--dsh-color-bg, #ffffff)',
  color: 'inherit',
}
const rail: React.CSSProperties = {
  position: 'fixed', left: 0, top: 0, bottom: 0,
  width: NAV_RAIL_WIDTH, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
  alignItems: 'center', paddingTop: 10, gap: 6, overflowY: 'auto',
  background: 'var(--dsh-color-surface-muted, rgba(127,127,127,0.08))',
  borderRight: '1px solid var(--dsh-color-border, rgba(127,127,127,0.25))',
}
const nav: React.CSSProperties = {
  width: NAV_WIDTH, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
  padding: '12px 10px', gap: 4, overflowY: 'auto',
  background: 'var(--dsh-color-surface-muted, rgba(127,127,127,0.08))',
  borderRight: '1px solid var(--dsh-color-border, rgba(127,127,127,0.25))',
}
const navHeader: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '0 4px 10px', flex: '0 0 auto',
}
const navTitle: React.CSSProperties = { fontSize: 14, fontWeight: 800, margin: 0, letterSpacing: 0.2 }
const navButton: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
  padding: '9px 10px', borderRadius: 10, border: '1px solid transparent', background: 'transparent',
  color: 'inherit', cursor: 'pointer', font: 'inherit', textAlign: 'left', flex: '0 0 auto',
  transition: 'background 0.15s ease, border-color 0.15s ease',
}
const navButtonActive: React.CSSProperties = {
  ...navButton,
  borderColor: 'var(--dsh-color-accent, #4c8bf5)',
  background: 'var(--dsh-color-accent, rgba(76,139,245,0.12))',
}
const navIcon: React.CSSProperties = { fontSize: 16, flex: '0 0 auto', width: 22, textAlign: 'center' }
const navLabel: React.CSSProperties = { fontSize: 13, fontWeight: 600, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const railButton: React.CSSProperties = {
  width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center',
  justifyContent: 'center', border: '1px solid transparent', background: 'transparent',
  color: 'inherit', cursor: 'pointer', fontSize: 18, flex: '0 0 auto',
  transition: 'background 0.15s ease, border-color 0.15s ease',
}
const railButtonActive: React.CSSProperties = {
  ...railButton,
  borderColor: 'var(--dsh-color-accent, #4c8bf5)',
  background: 'var(--dsh-color-accent, rgba(76,139,245,0.12))',
}
const page: React.CSSProperties = {
  flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
}
const pageHeader: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '16px 24px 12px', flex: '0 0 auto',
  borderBottom: '1px solid var(--dsh-color-border, rgba(127,127,127,0.18))',
}
const pageTitle: React.CSSProperties = { fontSize: 18, fontWeight: 800, margin: 0 }
const pageBody: React.CSSProperties = {
  flex: '1 1 auto', overflowY: 'auto', padding: '20px 24px 28px',
}
const grid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
  gap: 12,
}
const bigCard: React.CSSProperties = {
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.3))',
  borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
  background: 'var(--dsh-color-surface, transparent)',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease',
  cursor: 'pointer', color: 'inherit', font: 'inherit', textAlign: 'left', width: '100%', boxSizing: 'border-box',
}
const bigCardActive: React.CSSProperties = {
  ...bigCard,
  borderColor: 'var(--dsh-color-accent, #4c8bf5)',
  boxShadow: '0 2px 10px rgba(76,139,245,0.10)',
}
const muted: React.CSSProperties = { color: 'var(--dsh-color-text-muted, #888)', fontSize: 12, margin: 0 }
const searchInput: React.CSSProperties = {
  width: '100%', maxWidth: 420, boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.4))', background: 'transparent',
  color: 'inherit', fontSize: 13, marginBottom: 14,
}
const chip: React.CSSProperties = {
  display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11,
  background: 'var(--dsh-color-surface-muted, rgba(127,127,127,0.18))', marginRight: 4,
}
const smallButton: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.4))', background: 'transparent', color: 'inherit',
}
const primaryButton: React.CSSProperties = {
  ...smallButton,
  background: 'var(--dsh-color-accent, #4c8bf5)',
  borderColor: 'var(--dsh-color-accent, #4c8bf5)',
  color: '#fff', fontWeight: 700,
}
const dangerButton: React.CSSProperties = {
  ...smallButton,
  color: '#e5484d', borderColor: 'rgba(229,72,77,0.5)',
}
const collapseButton: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
  fontSize: 14, padding: '4px 8px', borderRadius: 8,
}
const inputField: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: 10,
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.4))', background: 'transparent',
  color: 'inherit', fontSize: 13,
}

function fmt(t: ExtendedTranslate, key: string, vars: Record<string, string | number>): string {
  let text = t(key)
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

// ────────────────────────── host clients（复用现有路由） ──────────────────────────

const MEMORY_STATE_ROUTE = '/dsh-desktop/memory/state'
const KNOWLEDGE_CARDS_ROUTE = '/dsh-desktop/knowledge/cards'
const WORKBUDDY_EXPERTS_ROUTE = '/dsh-desktop/experts/list'
const DAILY_NEWS_ROUTE = '/dsh-desktop/news/daily'

interface DailyNewsItemView {
  readonly id: string
  readonly title: string
  readonly url?: string
  readonly cover?: string
  readonly publishedAt: string
}

interface DailyNewsFeedView {
  readonly date: string
  readonly source: string
  readonly sourceUrl: string
  readonly items: readonly DailyNewsItemView[]
}

async function fetchDailyNews(force = false): Promise<DailyNewsFeedView | null> {
  try {
    const response = await fetch(`${DAILY_NEWS_ROUTE}${force ? '?refresh=1' : ''}`, { cache: 'no-store' })
    if (!response.ok) return null
    const body = await response.json() as DailyNewsFeedView
    return Array.isArray(body.items) ? body : null
  } catch {
    return null
  }
}

interface WorkBuddyExpertItem {
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

async function fetchWorkBuddyExperts(force = false): Promise<WorkBuddyExpertItem[] | null> {
  try {
    const response = await fetch(`${WORKBUDDY_EXPERTS_ROUTE}${force ? '?refresh=1' : ''}`, { cache: 'no-store' })
    if (!response.ok) return null
    const body = await response.json() as { experts?: WorkBuddyExpertItem[] }
    return Array.isArray(body.experts) ? body.experts : null
  } catch {
    return null
  }
}

interface MemoryPending {
  id: string
  target: 'memory' | 'user'
  origin: string
  createdAt: string
  operations: Array<{ action: string, content?: string, oldText?: string }>
}

interface MemoryStateView {
  version: number
  approval: boolean
  pending: MemoryPending[]
  targets: Array<{ target: 'memory' | 'user', charCount: number, charLimit: number, entries: string[] }>
  review: {
    enabled: boolean
    interval: number
    lastReviewedSecondsAgo: number
    lastRunAt: number
    lastOutcome: string
    lastError: string
  }
}

async function fetchMemoryState(): Promise<MemoryStateView | null> {
  try {
    const response = await fetch(MEMORY_STATE_ROUTE, { cache: 'no-store' })
    if (!response.ok) return null
    return await response.json() as MemoryStateView
  } catch {
    return null
  }
}

/** 沉淀：把手动表单写入知识库（POST /cards），成功/失败原样回显。 */
async function createKnowledgeCard(input: { title: string, summary: string, tags: string[] }): Promise<{ ok: boolean, error?: string }> {
  try {
    const response = await fetch(KNOWLEDGE_CARDS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
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

// ────────────────────────── 今日 focus ──────────────────────────

function TodayPage(props: { openSession: (id: SessionId) => void; useSessions: ExtendedPanelProps['useSessions'] }): React.ReactNode {
  const { openSession, useSessions } = props
  const [cards, setCards] = useState<KnowledgeCardView[] | null>(null)
  const [memory, setMemory] = useState<MemoryStateView | null>(null)
  const [distillOpen, setDistillOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean, text: string } | null>(null)

  const sessions = useSessions((state: SessionListState) => state)
  const currentId = sessions.current
  const current = currentId !== undefined ? sessions.byId[currentId] : undefined

  useEffect(() => {
    let disposed = false
    const refresh = async (): Promise<void> => {
      const [knowledge, ms] = await Promise.all([fetchKnowledgeState(), fetchMemoryState()])
      if (disposed) return
      if (knowledge !== null) setCards(knowledge.cards)
      if (ms !== null) setMemory(ms)
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, knowledgePollMs)
    return () => { disposed = true; clearInterval(timer) }
  }, [])

  const actions = useMemo(() => (cards ?? []).slice(0, 5), [cards])

  const submitDistill = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFeedback(null)
    try {
      const result = await createKnowledgeCard({
        title: title.trim(),
        summary: summary.trim(),
        tags: tags.split(',').map((s) => s.trim()).filter((s) => s !== ''),
      })
      if (!result.ok) {
        setFeedback({ ok: false, text: result.error ?? '沉淀失败，请重试' })
        return
      }
      setFeedback({ ok: true, text: '已沉淀为知识卡' })
      setTitle('')
      setSummary('')
      setTags('')
      setDistillOpen(false)
      const next = await fetchKnowledgeState()
      if (next !== null) setCards(next.cards)
    } finally {
      setBusy(false)
    }
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
    // 当前工作
    h('section', {},
      h('h3', { style: { fontSize: 15, fontWeight: 700, margin: '0 0 10px' } }, '当前工作'),
      current !== undefined
        ? h('button', { type: 'button', style: bigCardActive, onClick: () => { if (currentId !== undefined) openSession(currentId) } },
          h('span', { style: { fontSize: 15, fontWeight: 800 } }, current.displayTitle),
          h('span', { style: muted }, `${current.running ? '运行中 · ' : ''}${relativeTime(Date.now(), current.updatedAt)}`),
        )
        : h('p', { style: muted }, '还没有活动会话'),
      h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
        h('button', { type: 'button', className: 'bjyPrimary', style: primaryButton, onClick: () => { setDistillOpen(v => !v) } }, '↓ 沉淀本会话'),
        h('button', { type: 'button', style: smallButton, onClick: () => { setCards([]); void (async () => { const n = await fetchKnowledgeState(); if (n !== null) setCards(n.cards) })() } }, '刷新'),
      ),
      distillOpen
        ? h('div', { style: { ...bigCard, gap: 8, marginTop: 10 } },
          h('input', { style: inputField, placeholder: '标题（一句话结论）', value: title, onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setTitle(e.target.value) } }),
          h('textarea', { style: { ...inputField, minHeight: 80, resize: 'vertical' }, placeholder: '摘要 / 结论', value: summary, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { setSummary(e.target.value) } }),
          h('input', { style: inputField, placeholder: '标签（逗号分隔）', value: tags, onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setTags(e.target.value) } }),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', className: 'bjyPrimary', style: primaryButton, disabled: busy, onClick: () => { void submitDistill() } }, busy ? '沉淀中…' : '确认沉淀'),
            h('button', { type: 'button', style: smallButton, onClick: () => { setDistillOpen(false); setFeedback(null) } }, '取消'),
          ),
          feedback !== null ? h('p', { style: { ...muted, color: feedback.ok ? '#20a05a' : '#e5484d' } }, feedback.text) : null,
        )
        : null,
    ),
    // 下一步行动（记忆提示）
    h('section', {},
      h('h3', { style: { fontSize: 15, fontWeight: 700, margin: '0 0 10px' } }, '下一步行动'),
      actions.length === 0
        ? h('p', { style: muted }, '知识库为空：沉淀几条结论后这里会给出行动提示')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          ...actions.map((card) => h('div', { key: card.id, style: bigCard },
            h('span', { style: { fontSize: 14, fontWeight: 700 } }, card.title),
            h('span', { style: { fontSize: 12, color: 'var(--dsh-color-text-muted, #888)', lineHeight: 1.5 } }, card.summary.length > 90 ? `${card.summary.slice(0, 90)}…` : card.summary),
          )),
        ),
    ),
    // 待审批 + 健康速览
    h('section', {},
      h('h3', { style: { fontSize: 15, fontWeight: 700, margin: '0 0 10px' } }, '待办与健康'),
      memory !== null && memory.pending.length > 0
        ? h('div', { style: { ...bigCard, borderColor: 'rgba(229,72,77,0.4)' } },
          h('span', { style: { fontSize: 14, fontWeight: 700 } }, `待审批记忆 ${memory.pending.length} 条`),
          h('span', { style: muted }, memory.pending.map((p) => `${p.origin}`).join('、')),
        )
        : h('p', { style: muted }, '暂无待审批记忆'),
      cards !== null
        ? h('p', { style: muted }, `知识卡 ${cards.length} 张 · 记忆审批 ${memory?.approval === true ? '开' : '关'} · 自动审核 ${memory?.review.enabled === true ? '开' : '关'}`)
        : null,
    ),
  )
}

// ────────────────────────── 知识库 ──────────────────────────

function KnowledgePage(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [cards, setCards] = useState<KnowledgeCardView[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [distillOpen, setDistillOpen] = useState(false)
  const [nTitle, setNTitle] = useState('')
  const [nSummary, setNSummary] = useState('')
  const [nTags, setNTags] = useState('')
  const [nFeedback, setNFeedback] = useState<{ ok: boolean, text: string } | null>(null)
  const routeAvailable = useRef(false)

  useEffect(() => {
    let disposed = false
    const refresh = async (): Promise<void> => {
      const next = await fetchKnowledgeState()
      if (disposed) return
      if (next === null) {
        if (!routeAvailable.current) setLoadError(fmt(t, 'knowledgeLoadError', { error: t('knowledgeRouteUnavailable') }))
        return
      }
      routeAvailable.current = true
      setCards(next.cards)
      setLoadError('')
      setSelectedId((current) => {
        if (current !== null && next.cards.some((card) => card.id === current)) return current
        return null
      })
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, knowledgePollMs)
    return () => { disposed = true; clearInterval(timer) }
  }, [t])

  const refreshNow = async (): Promise<void> => {
    const next = await fetchKnowledgeState()
    if (next === null) {
      if (!routeAvailable.current) setLoadError(fmt(t, 'knowledgeLoadError', { error: t('knowledgeRouteUnavailable') }))
      return
    }
    routeAvailable.current = true
    setCards(next.cards)
    setLoadError('')
  }

  const remove = async (id: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setDeleteError('')
    try {
      const result = await deleteKnowledgeCard(id)
      if (!result.ok) {
        setDeleteError(fmt(t, 'knowledgeDeleteError', { error: result.error ?? t('knowledgeDeleteFailed') }))
        return
      }
      setCards((current) => current === null ? current : current.filter((card) => card.id !== id))
      if (selectedId === id) setSelectedId(null)
      setConfirmingId(null)
    } finally {
      setBusy(false)
    }
  }

  const submitNew = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNFeedback(null)
    try {
      const result = await createKnowledgeCard({ title: nTitle.trim(), summary: nSummary.trim(), tags: nTags.split(',').map((s) => s.trim()).filter((s) => s !== '') })
      if (!result.ok) {
        setNFeedback({ ok: false, text: result.error ?? '创建失败，请重试' })
        return
      }
      setNFeedback({ ok: true, text: '已创建' })
      setNTitle(''); setNSummary(''); setNTags(''); setDistillOpen(false)
      await refreshNow()
    } finally {
      setBusy(false)
    }
  }

  const filtered = useMemo(() => {
    if (cards === null) return []
    const needle = query.trim().toLowerCase()
    if (needle === '') return [...cards]
    return cards.filter((card) =>
      card.title.toLowerCase().includes(needle)
      || card.summary.toLowerCase().includes(needle)
      || card.tags.some((tag) => tag.toLowerCase().includes(needle)),
    )
  }, [cards, query])

  const detailCard = cards?.find((card) => card.id === selectedId) ?? null

  return h('div', {},
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' } },
      h('button', { type: 'button', className: 'bjyPrimary', style: primaryButton, onClick: () => { setDistillOpen(v => !v) } }, '↓ 沉淀本会话'),
      h('button', { type: 'button', style: smallButton, onClick: () => { void refreshNow() } }, '刷新'),
    ),
    distillOpen
      ? h('div', { style: { ...bigCard, gap: 8, marginBottom: 12 } },
        h('input', { style: inputField, placeholder: '标题（一句话结论）', value: nTitle, onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setNTitle(e.target.value) } }),
        h('textarea', { style: { ...inputField, minHeight: 80, resize: 'vertical' }, placeholder: '摘要 / 结论', value: nSummary, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => { setNSummary(e.target.value) } }),
        h('input', { style: inputField, placeholder: '标签（逗号分隔）', value: nTags, onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setNTags(e.target.value) } }),
        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', className: 'bjyPrimary', style: primaryButton, disabled: busy, onClick: () => { void submitNew() } }, busy ? '创建中…' : '确认创建'),
          h('button', { type: 'button', style: smallButton, onClick: () => { setDistillOpen(false); setNFeedback(null) } }, '取消'),
        ),
        nFeedback !== null ? h('p', { style: { ...muted, color: nFeedback.ok ? '#20a05a' : '#e5484d' } }, nFeedback.text) : null,
      )
      : null,
    h('input', {
      style: searchInput,
      placeholder: t('knowledgeSearchPlaceholder'),
      value: query,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value) },
    }),
    loadError !== ''
      ? h('p', { style: muted }, loadError)
      : cards === null
        ? h('p', { style: muted }, '…')
        : detailCard !== null
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 } },
            h('button', { type: 'button', style: smallButton, onClick: () => { setSelectedId(null) } }, t('knowledgeDetailBack')),
            h('div', { style: { fontSize: 20, fontWeight: 800 } }, detailCard.title),
            h('p', { style: { fontSize: 14, margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, detailCard.summary),
            detailCard.tags.length > 0
              ? h('div', {}, h('span', { style: muted }, `${t('knowledgeTags')}: `), ...detailCard.tags.map((tag) => h('span', { key: tag, style: chip }, tag)))
              : null,
            h('p', { style: muted }, `${t('knowledgeSource')}: ${detailCard.source}`),
            h('p', { style: muted }, `${fmt(t, 'knowledgeUpdated', { time: relativeTime(Date.now(), detailCard.updatedAt) })} · ${fmt(t, 'knowledgeCreated', { time: relativeTime(Date.now(), detailCard.createdAt) })}`),
            deleteError !== '' ? h('p', { style: { ...muted, color: '#e5484d' } }, deleteError) : null,
            confirmingId === detailCard.id
              ? h('div', { style: { display: 'flex', gap: 8 } },
                h('button', { type: 'button', style: dangerButton, disabled: busy, onClick: () => { void remove(detailCard.id) } }, busy ? t('knowledgeDeleteBusy') : t('knowledgeDeleteConfirm')),
                h('button', { type: 'button', style: smallButton, onClick: () => { setConfirmingId(null) } }, t('knowledgeDeleteCancel')),
              )
              : h('div', { style: { display: 'flex', gap: 8 } },
                h('button', { type: 'button', style: dangerButton, onClick: () => { setConfirmingId(detailCard.id) } }, t('knowledgeDelete')),
              ),
          )
          : filtered.length === 0
            ? h('p', { style: muted }, query.trim() === '' ? t('knowledgeEmpty') : fmt(t, 'knowledgeSearchEmpty', { query: query.trim() }))
            : h('div', { style: grid },
              ...filtered.map((card) => h('button', {
                key: card.id,
                type: 'button',
                style: selectedId === card.id ? bigCardActive : bigCard,
                onClick: () => { setSelectedId(card.id); setDeleteError(''); setConfirmingId(null) },
              },
              h('span', { style: { fontSize: 14, fontWeight: 700 } }, card.title),
              h('span', { style: { fontSize: 12, color: 'var(--dsh-color-text-muted, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, card.summary),
              card.tags.length > 0 ? h('span', {}, ...card.tags.map((tag) => h('span', { key: tag, style: chip }, tag))) : null,
              )),
            ),
  )
}

// ────────────────────────── 专家（boujoy 03 调用阵容） ──────────────────────────

function ExpertsPage(): React.ReactNode {
  const [experts, setExperts] = useState<WorkBuddyExpertItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void (async () => {
      const next = await fetchWorkBuddyExperts()
      if (!disposed && next !== null) setExperts(next)
    })()
    return () => { disposed = true }
  }, [])

  const filtered = useMemo(() => {
    if (experts === null) return []
    const needle = query.trim().toLowerCase()
    if (needle === '') return [...experts]
    return experts.filter((expert) =>
      expert.name.toLowerCase().includes(needle)
      || (expert.displayName.zh ?? '').toLowerCase().includes(needle)
      || (expert.profession.zh ?? '').toLowerCase().includes(needle)
      || (expert.description.zh ?? '').toLowerCase().includes(needle)
      || expert.tags.some((tag) => (tag.zh ?? '').toLowerCase().includes(needle) || (tag.en ?? '').toLowerCase().includes(needle)),
    )
  }, [experts, query])

  const callExpert = async (expert: WorkBuddyExpertItem): Promise<void> => {
    const zh = expert.displayName.zh ?? expert.displayName.en ?? expert.name
    const prof = expert.profession.zh ?? expert.profession.en ?? ''
    const desc = expert.description.zh ?? expert.description.en ?? ''
    const text = `请按以下专家配置完成任务。\n《${zh}》\n${prof !== '' ? `职业：${prof}\n` : ''}${desc !== '' ? `${desc}\n` : ''}`
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(expert.id)
      setTimeout(() => { setCopiedId((current) => current === expert.id ? null : current) }, 1500)
    } catch {
      setCopiedId(null)
    }
  }

  return h('div', {},
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' } },
      h('input', {
        style: { ...searchInput, marginBottom: 0, maxWidth: 320, flex: '1 1 200px' },
        placeholder: '搜索专家…',
        value: query,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setQuery(e.target.value) },
      }),
      h('button', { type: 'button', style: smallButton, onClick: () => { void (async () => { const next = await fetchWorkBuddyExperts(true); if (next !== null) setExperts(next) })() } }, '刷新'),
      experts !== null ? h('span', { style: muted }, `${filtered.length} 位专家`) : null,
    ),
    experts === null
      ? h('p', { style: muted }, '…')
      : filtered.length === 0
        ? h('p', { style: muted }, experts.length === 0 ? '未发现 WorkBuddy 专家（~/.workbuddy/plugins/marketplaces）' : '没有匹配的专家')
        : h('div', { style: grid },
          ...filtered.map((expert) => {
            const zh = expert.displayName.zh ?? expert.displayName.en ?? expert.name
            const prof = expert.profession.zh ?? expert.profession.en ?? ''
            const desc = expert.description.zh ?? expert.description.en ?? ''
            return h('div', { key: expert.id, style: { ...bigCard, cursor: 'default' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                expert.hasAvatar
                  ? h('img', { src: expert.avatarRoute, alt: zh, style: { width: 44, height: 44, borderRadius: 10, objectFit: 'cover', flex: '0 0 auto' } })
                  : h('div', { style: { width: 44, height: 44, borderRadius: 10, background: 'linear-gradient(135deg, #2563eb, #0f766e)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 800, flex: '0 0 auto' } }, zh.slice(0, 1)),
                h('div', { style: { minWidth: 0 } },
                  h('div', { style: { fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, zh),
                  h('div', { style: muted }, prof !== '' ? prof : expert.expertType),
                ),
              ),
              desc !== '' ? h('span', { style: { fontSize: 12, color: 'var(--dsh-color-text-muted, #888)', lineHeight: 1.5 } }, desc.length > 90 ? `${desc.slice(0, 90)}…` : desc) : null,
              expert.tags.length > 0
                ? h('div', {}, ...expert.tags.slice(0, 5).map((tag, i) => h('span', { key: i, style: chip }, tag.zh ?? tag.en ?? '')))
                : null,
              h('div', { style: { display: 'flex', gap: 8 } },
                h('button', { type: 'button', className: 'bjyPrimary', style: primaryButton, onClick: () => { void callExpert(expert) } }, copiedId === expert.id ? '✓ 已复制调用' : '调用专家 →'),
                h('span', { style: { ...muted, marginLeft: 'auto' } }, expert.marketplace),
              ),
            )
          }),
        ),
    h('p', { style: { ...muted, marginTop: 10 } }, '调用 = 复制「请按以下专家配置完成任务」文案，粘贴到对话即可（与 WorkBuddy 联动注入后置）'),
  )
}

// ────────────────────────── 图谱（新闻 + 宽幅关系图） ──────────────────────────

function GraphPage(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [cards, setCards] = useState<KnowledgeCardView[]>([])

  useEffect(() => {
    let disposed = false
    void (async () => {
      const knowledge = await fetchKnowledgeState()
      if (!disposed && knowledge !== null) setCards(knowledge.cards)
    })()
    return () => { disposed = true }
  }, [])

  const edges = useMemo(() => {
    const result: Array<{ a: number; b: number; tag: string }> = []
    const limited = cards.slice(0, 12)
    for (let i = 0; i < limited.length; i += 1) {
      for (let j = i + 1; j < limited.length; j += 1) {
        const shared = (limited[i]!.tags ?? []).find((tag) => (limited[j]!.tags ?? []).includes(tag))
        if (shared !== undefined) result.push({ a: i, b: j, tag: shared })
      }
    }
    return result
  }, [cards])

  const graphNode = (index: number, count: number): { x: number; y: number } => {
    const cx = 400; const cy = 180; const rx = 300; const ry = 130
    const angle = (index / Math.max(1, count)) * Math.PI * 2 - Math.PI / 2
    return { x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) }
  }

  const graphCount = Math.min(cards.length, 12)

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
    h('div', {},
      h('h3', { style: { fontSize: 15, fontWeight: 700, margin: '0 0 10px' } }, t('graphTitle')),
      graphCount < 2
        ? h('p', { style: muted }, t('graphEmpty'))
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('svg', { viewBox: '0 0 800 360', style: { width: '100%', height: 'auto', display: 'block', borderRadius: 12, border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.2))' }, role: 'img', 'aria-label': t('graphTitle') },
            ...edges.map((edge, index) => {
              const from = graphNode(edge.a, graphCount)
              const to = graphNode(edge.b, graphCount)
              return h('line', {
                key: `edge-${index}`,
                x1: from.x, y1: from.y, x2: to.x, y2: to.y,
                stroke: '#cbd5e1',
                strokeWidth: 1.5,
              })
            }),
            ...cards.slice(0, graphCount).map((card, index) => {
              const point = graphNode(index, graphCount)
              return h('g', { key: card.id },
                h('circle', { cx: point.x, cy: point.y, r: 26, fill: '#2563eb', opacity: 0.92 }),
                h('text', {
                  x: point.x, y: point.y + 4, textAnchor: 'middle',
                  fill: '#fff', fontSize: 12, fontWeight: 700, style: { pointerEvents: 'none' },
                }, String(index + 1)),
                h('text', {
                  x: point.x, y: point.y + 44, textAnchor: 'middle',
                  fill: '#64748b', fontSize: 11,
                  style: { pointerEvents: 'none' },
                }, card.title.length > 12 ? `${card.title.slice(0, 12)}…` : card.title),
              )
            }),
          ),
          h('p', { style: muted }, t('graphHint')),
          edges.length > 0
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              ...edges.map((edge, index) => h('span', { key: `tag-${index}`, style: chip }, edge.tag)),
            )
            : null,
        ),
    ),
  )
}

// ────────────────────────── 每日热点（boujoy 06 FEED：AI 动态与工具） ──────────────────────────

function DailyNewsPage(): React.ReactNode {
  const [feed, setFeed] = useState<DailyNewsFeedView | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let disposed = false
    void (async () => {
      const next = await fetchDailyNews()
      if (!disposed && next !== null) setFeed(next)
    })()
    return () => { disposed = true }
  }, [])

  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const next = await fetchDailyNews(true)
      if (next !== null) setFeed(next)
    } finally {
      setRefreshing(false)
    }
  }

  const dateLabel = feed?.date ?? ''
  const source = feed?.source ?? ''
  const sourceUrl = feed?.sourceUrl ?? ''

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      dateLabel !== '' ? h('span', { style: { fontSize: 14, fontWeight: 800, fontFamily: 'ui-monospace, Consolas, monospace', letterSpacing: '0.04em' } }, `FEED / ${dateLabel}`) : null,
      source !== '' ? h('span', { style: { ...muted, fontSize: 12 } }, `来源：${source}`) : null,
      h('button', { type: 'button', style: smallButton, disabled: refreshing, onClick: () => { void refresh() } }, refreshing ? '抓取中…' : '↻ 刷新抓取'),
      sourceUrl !== '' ? h('a', { href: sourceUrl, target: '_blank', rel: 'noopener noreferrer', style: { fontSize: 12 } }, `打开来源 ↗`) : null,
    ),
    feed === null
      ? h('p', { style: muted }, '每日热点加载中…（若长期为空：Google News 可能被墙，已内置 36氪 回退）')
      : feed.items.length === 0
        ? h('p', { style: muted }, '近三日暂无 AI 热点')
        : h('div', { style: grid },
          ...feed.items.map((item) => h('a', {
            key: item.id,
            href: item.url ?? '#',
            target: item.url !== undefined ? '_blank' : undefined,
            rel: 'noopener noreferrer',
            style: { ...bigCard, textDecoration: 'none', cursor: item.url !== undefined ? 'pointer' : 'default' },
          },
          h('div', { className: 'bjyNewsThumb' },
            item.cover !== undefined && item.cover !== ''
              ? h('img', { src: item.cover, alt: '', loading: 'lazy', decoding: 'async' })
              : null,
            h('span', { className: 'bjyNewsThumbMark' }, 'NEWS'),
          ),
          h('span', { style: { fontSize: 14, fontWeight: 700, lineHeight: 1.45 } }, item.title),
          h('span', { style: muted }, `${relativeTime(Date.now(), item.publishedAt)} · ${source}`),
          h('span', { style: { fontSize: 12, color: 'var(--bjy-secondary, #0f766e)', fontWeight: 700 } }, '阅读原文 ↗'),
          )),
        ),
  )
}

// ────────────────────────── 健康中心（只读候选，不删除） ──────────────────────────

function HealthPage(): React.ReactNode {
  const [cards, setCards] = useState<KnowledgeCardView[] | null>(null)
  const [memory, setMemory] = useState<MemoryStateView | null>(null)

  useEffect(() => {
    let disposed = false
    const refresh = async (): Promise<void> => {
      const [knowledge, ms] = await Promise.all([fetchKnowledgeState(), fetchMemoryState()])
      if (disposed) return
      if (knowledge !== null) setCards(knowledge.cards)
      if (ms !== null) setMemory(ms)
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, knowledgePollMs)
    return () => { disposed = true; clearInterval(timer) }
  }, [])

  const issues = useMemo(() => {
    if (cards === null) return []
    const result: Array<{ id: string; title: string; reason: string }> = []
    const seen = new Map<string, number>()
    for (const card of cards) {
      const fingerprint = `${card.title.trim().toLowerCase()}|${card.summary.trim().toLowerCase()}`
      seen.set(fingerprint, (seen.get(fingerprint) ?? 0) + 1)
    }
    for (const card of cards) {
      if (card.title.trim() === '') result.push({ id: card.id, title: card.title || '(无标题)', reason: '标题为空' })
      else if (card.summary.trim().length < 20) result.push({ id: card.id, title: card.title, reason: '摘要过短（<20 字）' })
      else if (card.tags.length === 0) result.push({ id: card.id, title: card.title, reason: '无标签' })
      const fingerprint = `${card.title.trim().toLowerCase()}|${card.summary.trim().toLowerCase()}`
      if ((seen.get(fingerprint) ?? 0) > 1) result.push({ id: card.id, title: card.title, reason: '疑似重复（同标题+摘要）' })
    }
    return result
  }, [cards])

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 18 } },
    h('section', {},
      h('h3', { style: { fontSize: 15, fontWeight: 700, margin: '0 0 10px' } }, '知识健康'),
      cards === null
        ? h('p', { style: muted }, '…')
        : h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { ...bigCard, cursor: 'default' } }, h('span', { style: { fontSize: 22, fontWeight: 800 } }, String(cards.length)), h('span', { style: muted }, '知识卡总数')),
          h('div', { style: { ...bigCard, cursor: 'default' } }, h('span', { style: { fontSize: 22, fontWeight: 800, color: issues.length > 0 ? '#e5484d' : '#20a05a' } }, String(issues.length)), h('span', { style: muted }, '待处理问题')),
        ),
      h('div', { style: { marginTop: 12 } },
        issues.length === 0
          ? h('p', { style: muted }, '知识库健康 ✓（无过短/无标签/重复问题）')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            ...issues.slice(0, 50).map((issue) => h('div', { key: `${issue.id}-${issue.reason}`, style: { ...bigCard, cursor: 'default', padding: 10 } },
              h('span', { style: { fontSize: 13, fontWeight: 700 } }, issue.title),
              h('span', { style: { ...muted, color: '#e5484d' } }, issue.reason),
            )),
          ),
      ),
    ),
    h('section', {},
      h('h3', { style: { fontSize: 15, fontWeight: 700, margin: '0 0 10px' } }, '记忆健康'),
      memory === null
        ? h('p', { style: muted }, '…')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          ...memory.targets.map((target) => h('div', { key: target.target, style: bigCard },
            h('span', { style: { fontSize: 14, fontWeight: 700 } }, target.target === 'memory' ? 'MEMORY.md' : 'USER.md'),
            h('span', { style: muted }, `${target.charCount} / ${target.charLimit} 字符（${Math.round((target.charCount / Math.max(1, target.charLimit)) * 100)}%）`),
            h('div', { style: { height: 6, borderRadius: 999, background: 'var(--dsh-color-surface-muted, rgba(127,127,127,0.18))', overflow: 'hidden' } },
              h('div', { style: { height: '100%', width: `${Math.min(100, Math.round((target.charCount / Math.max(1, target.charLimit)) * 100))}%`, background: 'var(--dsh-color-accent, #4c8bf5)' } }),
            ),
          )),
          h('p', { style: muted }, `审批 ${memory.approval ? '开' : '关'} · 自动审核 ${memory.review.enabled ? '开' : '关'}（上次：${memory.review.lastOutcome || '—'}）`),
          memory.pending.length > 0 ? h('p', { style: { ...muted, color: '#e5484d' } }, `待审批 ${memory.pending.length} 条`) : null,
        ),
    ),
  )
}

// ────────────────────────── 阅读器（知识卡全文 + 复制） ──────────────────────────

function ReaderPage(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [cards, setCards] = useState<KnowledgeCardView[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let disposed = false
    void (async () => {
      const next = await fetchKnowledgeState()
      if (!disposed && next !== null) setCards(next.cards)
    })()
    return () => { disposed = true }
  }, [])

  const selected = cards?.find((card) => card.id === selectedId) ?? null

  const copy = async (): Promise<void> => {
    if (selected === null) return
    try {
      await navigator.clipboard.writeText(`# ${selected.title}\n\n${selected.summary}\n\n${selected.tags.map((tag) => `#${tag}`).join(' ')}`)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1200)
    } catch {
      setCopied(false)
    }
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
    h('p', { style: muted }, '本地 Markdown 阅读器（v1：知识卡全文；后续可扩展 memory/*.md 源与“发回 Agent”）'),
    cards === null
      ? h('p', { style: muted }, '…')
      : selected !== null
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 } },
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', style: smallButton, onClick: () => { setSelectedId(null) } }, '← 返回列表'),
            h('button', { type: 'button', style: smallButton, onClick: () => { void copy() } }, copied ? '✓ 已复制' : '复制全文'),
          ),
          h('div', { style: { fontSize: 22, fontWeight: 800 } }, selected.title),
          h('pre', { style: { fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' } }, selected.summary),
          h('div', {}, ...selected.tags.map((tag) => h('span', { key: tag, style: chip }, `#${tag}`))),
          h('p', { style: muted }, `${t('knowledgeSource')}: ${selected.source} · ${relativeTime(Date.now(), selected.updatedAt)}`),
        )
        : h('div', { style: grid },
          ...cards.map((card) => h('button', {
            key: card.id,
            type: 'button',
            style: bigCard,
            onClick: () => { setSelectedId(card.id) },
          },
          h('span', { style: { fontSize: 14, fontWeight: 700 } }, card.title),
          h('span', { style: { fontSize: 12, color: 'var(--dsh-color-text-muted, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, card.summary),
          )),
        ),
  )
}

// ────────────────────────── 专家风格 ──────────────────────────

function ExpertStylePage(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [style, setStyle] = useState<string>(() => {
    try {
      return localStorage.getItem('dsh-desktop.expert-style') ?? 'balanced'
    } catch {
      return 'balanced'
    }
  })
  const modes = [
    { id: 'balanced', icon: '⚖️', label: t('expertBalanced'), desc: t('expertBalancedDesc') },
    { id: 'rigorous', icon: '🔬', label: t('expertRigorous'), desc: t('expertRigorousDesc') },
    { id: 'creative', icon: '🎨', label: t('expertCreative'), desc: t('expertCreativeDesc') },
    { id: 'concise', icon: '✂️', label: t('expertConcise'), desc: t('expertConciseDesc') },
    { id: 'deep', icon: '🧠', label: t('expertDeep'), desc: t('expertDeepDesc') },
  ]
  const select = (id: string): void => {
    setStyle(id)
    try {
      localStorage.setItem('dsh-desktop.expert-style', id)
    } catch {
      // Persistence is best-effort; the in-memory selection still applies.
    }
  }
  return h('div', {},
    h('p', { style: muted }, t('expertHint')),
    h('div', { style: grid },
      ...modes.map((mode) => {
        const active = mode.id === style
        return h('button', {
          key: mode.id,
          type: 'button',
          style: active ? bigCardActive : bigCard,
          onClick: () => { select(mode.id) },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 20 } }, mode.icon),
          h('span', { style: { fontSize: 14, fontWeight: 700 } }, mode.label),
          active ? h('span', { style: { fontSize: 14, color: 'var(--dsh-color-accent, #4c8bf5)', marginLeft: 'auto' } }, '✓') : null,
        ),
        h('span', { style: muted }, mode.desc),
        )
      }),
    ),
  )
}


// ────────────────────────── 统一存储 (S2/S3) ──────────────────────────

function StorePage(): React.ReactNode {
  const [stats, setStats] = useState<StoreStatsView | null>(null)
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null)
  const [pages, setPages] = useState<KnowledgePageView[] | null>(null)
  const [graph, setGraph] = useState<GraphView | null>(null)
  const [docQuery, setDocQuery] = useState('')
  const [docResults, setDocResults] = useState<Array<{ content: string, path: string }> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    const [s, c, p, g] = await Promise.all([
      fetchStoreStats(),
      fetchCandidates(),
      fetchKnowledgePages(),
      fetchGraph(),
    ])
    if (s !== null) setStats(s)
    if (c !== null) setCandidates(c)
    if (p !== null) setPages(p.pages)
    if (g !== null) setGraph(g)
  }

  useEffect(() => {
    void refresh()
    const id = setInterval(() => { void refresh() }, 8000)
    return () => clearInterval(id)
  }, [])

  const act = async (id: string, kind: 'approve' | 'reject'): Promise<void> => {
    setBusy(id)
    setMsg(null)
    const result = kind === 'approve' ? await approveCandidate(id) : await rejectCandidate(id)
    setBusy(null)
    if (result.ok) {
      setMsg(kind === 'approve' ? '已批准，已同步到 MEMORY.md' : '已拒绝')
      void refresh()
    } else {
      setMsg(result.error ?? '操作失败')
    }
  }

  const searchDoc = async (): Promise<void> => {
    if (docQuery.trim() === '') return
    const res = await searchDocuments(docQuery.trim(), 8)
    if (res !== null && Array.isArray((res as { chunks?: unknown }).chunks)) {
      setDocResults((res as { chunks: Array<{ content: string, path: string }> }).chunks)
    } else {
      setDocResults([])
    }
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
    msg !== null ? h('div', { style: { padding: '8px 12px', borderRadius: 8, background: 'var(--dsh-color-accent, rgba(76,139,245,0.12))', fontSize: 12 } }, msg) : null,
    h('section', {},
      h('h3', { style: { fontSize: 13, fontWeight: 800, margin: '0 0 8px' } }, '存储概览（SQLite 统一事实层）'),
      stats === null
        ? h('span', { style: muted }, '加载中…')
        : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 } },
            h('div', { style: bigCard }, h('div', { style: { fontSize: 11, color: '#888' } }, 'Facts'), h('div', { style: { fontSize: 20, fontWeight: 800 } }, String(stats.facts))),
            h('div', { style: bigCard }, h('div', { style: { fontSize: 11, color: '#888' } }, 'Cards'), h('div', { style: { fontSize: 20, fontWeight: 800 } }, String(stats.cards))),
            h('div', { style: bigCard }, h('div', { style: { fontSize: 11, color: '#888' } }, 'Chunks'), h('div', { style: { fontSize: 20, fontWeight: 800 } }, String(stats.chunks))),
            h('div', { style: bigCard }, h('div', { style: { fontSize: 11, color: '#888' } }, 'Pending'), h('div', { style: { fontSize: 20, fontWeight: 800, color: stats.pending > 0 ? '#d93025' : undefined } }, String(stats.pending))),
          ),
    ),
    h('section', {},
      h('h3', { style: { fontSize: 13, fontWeight: 800, margin: '0 0 8px' } }, `待审队列（${String(candidates?.length ?? 0)}） — 模型只产候选，批准后落事实`),
      candidates === null
        ? h('span', { style: muted }, '加载中…')
        : candidates.length === 0
          ? h('span', { style: muted }, '暂无待审，候选队列为空')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              ...candidates.slice(0, 10).map(c => h('div', { key: c.id, style: { ...bigCard, cursor: 'default' } },
                h('div', { style: { fontSize: 12, fontWeight: 700, wordBreak: 'break-all' } }, c.content),
                h('div', { style: { fontSize: 11, color: '#888' } }, `${c.target} · ${c.id.slice(0, 8)} · ${relativeTime(Date.now(), c.createdAt)}前`),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                  h('button', { type: 'button', disabled: busy === c.id, style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #4c8bf5', background: '#4c8bf5', color: '#fff', cursor: 'pointer', fontSize: 12 }, onClick: () => { void act(c.id, 'approve') } }, busy === c.id ? '…' : '批准'),
                  h('button', { type: 'button', disabled: busy === c.id, style: { padding: '4px 10px', borderRadius: 6, border: '1px solid #888', background: 'transparent', cursor: 'pointer', fontSize: 12 }, onClick: () => { void act(c.id, 'reject') } }, '拒绝'),
                ),
              )),
            ),
    ),
    h('section', {},
      h('h3', { style: { fontSize: 13, fontWeight: 800, margin: '0 0 8px' } }, '知识页（由 facts 聚合的可重建投影）'),
      pages === null
        ? h('span', { style: muted }, '加载中…')
        : pages.length === 0
          ? h('span', { style: muted }, '暂无知识页，完成一次 /distill 或知识卡沉淀后自动生成')
          : h('div', { style: grid },
              ...pages.slice(0, 8).map(p => h('div', { key: p.id, style: bigCard },
                h('div', { style: { fontSize: 13, fontWeight: 700 } }, p.title),
                h('div', { style: { fontSize: 11, color: '#888' } }, `卡片 ${String(p.cardIds.length)} · 标签 ${p.tags.join(', ') || '—'}`),
              )),
            ),
    ),
    h('section', {},
      h('h3', { style: { fontSize: 13, fontWeight: 800, margin: '0 0 8px' } }, '文档邻域检索（混合 FTS5 + CJK bigram）'),
      h('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
        h('input', { type: 'text', value: docQuery, placeholder: '输入关键词，检索文档块与知识卡', style: { flex: '1 1 auto', padding: '6px 10px', borderRadius: 8, border: '1px solid #888', fontSize: 12 }, onInput: (e: unknown) => { const v = (e as { currentTarget: { value: string } }).currentTarget.value; setDocQuery(v) }, onKeyDown: (e: unknown) => { const ke = e as { key: string }; if (ke.key === 'Enter') void searchDoc() } }),
        h('button', { type: 'button', style: { padding: '6px 12px', borderRadius: 8, border: '1px solid #4c8bf5', background: '#4c8bf5', color: '#fff', cursor: 'pointer', fontSize: 12 }, onClick: () => { void searchDoc() } }, '检索'),
      ),
      docResults === null ? null
        : docResults.length === 0 ? h('span', { style: muted }, '无命中，试试更短的关键词或 CJK 双字')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            ...docResults.map((r, i) => h('div', { key: String(i), style: bigCard },
              h('div', { style: { fontSize: 12, fontWeight: 600, color: '#888' } }, r.path),
              h('div', { style: { fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, r.content.slice(0, 300)),
            )),
          ),
    ),
    graph !== null && graph.edges.length > 0
      ? h('section', {},
          h('h3', { style: { fontSize: 13, fontWeight: 800, margin: '0 0 8px' } }, `关系图（${String(graph.edges.length)} 条边，共享标签权重）`),
          h('div', { style: { fontSize: 11, color: '#888' } }, graph.edges.slice(0, 12).map(e => `${e.sourceId.slice(0,4)}→${e.targetId.slice(0,4)}(${e.type}:${String(e.weight)})`).join('  ')),
        )
      : null,
  )
}


/**
 * The boujoy-fused full-page workspace. Collapsed it renders the compact
 * rail; expanded it renders the slim nav (220px) plus the active page.
 */
export function ExtendedPanel(props: ExtendedPanelProps): React.ReactNode {
  const { t, layout, openSession, collapsed, useSessions } = props
  const [active, setActive] = useState<PageId>('today')

  if (collapsed) {
    return h('div', { style: rail, role: 'navigation', 'aria-label': t('nav') },
      ...navItems.map((item) => h('button', {
        key: item.id,
        type: 'button',
        title: item.label,
        'aria-label': item.label,
        className: active === item.id ? 'bjyRailActive' : undefined,
        style: active === item.id ? railButtonActive : railButton,
        onClick: () => {
          setActive(item.id)
          layout.openExtended()
        },
      }, item.icon)),
    )
  }

  const activeItem = navItems.find((item) => item.id === active) ?? navItems[0]!

  return h('div', { style: workspace, className: 'bjyWorkspace', role: 'dialog', 'aria-label': t('nav') },
    h('nav', { style: nav, className: 'bjyNav', role: 'navigation', 'aria-label': t('nav') },
      h('div', { style: navHeader },
        h('h2', { style: navTitle }, t('nav')),
        h('button', { type: 'button', style: collapseButton, title: t('collapse'), 'aria-label': t('collapse'), onClick: () => { layout.toggleExtended() } }, '«'),
      ),
      ...navItems.map((item) => h('button', {
        key: item.id,
        type: 'button',
        className: active === item.id ? 'bjyNavActive' : undefined,
        style: active === item.id ? navButtonActive : navButton,
        onClick: () => { setActive(item.id) },
      },
      h('span', { style: navIcon }, item.icon),
      h('span', { style: navLabel }, item.label),
      )),
      h('div', { style: { flex: '1 1 auto' } }),
      h('button', {
        type: 'button', style: navButton,
        title: t('collapse'), onClick: () => { layout.toggleExtended() },
      },
      h('span', { style: navIcon }, '✕'),
      h('span', { style: navLabel }, t('collapse')),
      ),
    ),
    h('main', { style: page, className: 'bjyPage' },
      h('div', { style: pageHeader },
        h('h1', { className: 'bjyPageTitle', style: pageTitle }, `${String(navItems.findIndex((item) => item.id === active) + 1).padStart(2, '0')} · ${activeItem.label}`),
        h('button', { type: 'button', style: collapseButton, title: t('collapse'), 'aria-label': t('collapse'), onClick: () => { layout.toggleExtended() } }, '✕'),
      ),
      h('div', { style: pageBody, className: 'bjyPageBody' },
        active === 'today'
          ? h(TodayPage, { openSession, useSessions })
          : active === 'knowledge'
            ? h(KnowledgePage, { t })
            : active === 'experts'
              ? h(ExpertsPage, {})
              : active === 'graph'
                ? h(GraphPage, { t })
                : active === 'news'
                  ? h(DailyNewsPage, {})
                  : active === 'health'
                    ? h(HealthPage, {})
                    : active === 'reader'
                      ? h(ReaderPage, { t })
                      : active === 'store'
                        ? h(StorePage, {})
                        : h(ExpertStylePage, { t }),
      ),
    ),
  )
}
