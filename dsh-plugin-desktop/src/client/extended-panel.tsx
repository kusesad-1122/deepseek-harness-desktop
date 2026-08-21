/**
 * Left extended panel (advanced mode only): a vertical stack of four desktop
 * sections rendered OUTSIDE the upstream sidebar — 对话 (recent sessions),
 * 知识卡 (knowledge base: list/detail/delete/search), 新闻与知识图谱 (news
 * items plus a tag-derived card graph), and 专家风格模式 (local style picker).
 *
 * Owned by the desktop advanced root: the frame declares the `panel.extended`
 * child slot and this component registers into it. Toggling the panel between
 * the compact rail and its wide column rides DesktopLayoutState, the same
 * observable the sidebar uses.
 */

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import {
  deleteKnowledgeCard, fetchKnowledgeState, fetchNewsItems, relativeTime,
} from './knowledge-client.ts'
import type { KnowledgeCardView, NewsItemView } from './knowledge-client.ts'
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

type SectionId = 'conversation' | 'knowledge' | 'news' | 'expert'

const knowledgePollMs = 5_000

const surface: React.CSSProperties = { height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }
const railStyle: React.CSSProperties = {
  height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
  paddingTop: 8, gap: 4, overflowY: 'auto',
}
const railButton: React.CSSProperties = {
  width: 40, height: 40, borderRadius: 8, display: 'flex', alignItems: 'center',
  justifyContent: 'center', border: '1px solid transparent', background: 'transparent',
  color: 'inherit', cursor: 'pointer', fontSize: 18, flex: '0 0 auto',
}
const railButtonActive: React.CSSProperties = {
  ...railButton,
  borderColor: 'var(--dsh-color-border, rgba(127,127,127,0.4))',
  background: 'var(--dsh-color-surface-muted, rgba(127,127,127,0.15))',
}
const headerRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '10px 12px 6px', flex: '0 0 auto',
}
const headerTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, margin: 0 }
const collapseButton: React.CSSProperties = {
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
  fontSize: 13, padding: '2px 6px', borderRadius: 6,
}
const body: React.CSSProperties = { flex: '1 1 auto', overflowY: 'auto', padding: '0 10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }
const sectionCard: React.CSSProperties = {
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
  borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, flex: '0 0 auto',
}
const sectionTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, margin: 0 }
const muted: React.CSSProperties = { color: 'var(--dsh-color-text-muted, #888)', fontSize: 12, margin: 0 }
const searchInput: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.4))', background: 'transparent',
  color: 'inherit', fontSize: 12,
}
const cardRow: React.CSSProperties = {
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.3))', borderRadius: 6,
  padding: '6px 8px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
  background: 'transparent', color: 'inherit', textAlign: 'left', width: '100%', boxSizing: 'border-box',
  font: 'inherit',
}
const cardRowActive: React.CSSProperties = {
  ...cardRow,
  borderColor: 'var(--dsh-color-accent, #4c8bf5)',
}
const chip: React.CSSProperties = {
  display: 'inline-block', padding: '1px 6px', borderRadius: 999, fontSize: 11,
  background: 'var(--dsh-color-surface-muted, rgba(127,127,127,0.18))', marginRight: 4,
}
const smallButton: React.CSSProperties = {
  padding: '3px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.4))', background: 'transparent', color: 'inherit',
}
const dangerButton: React.CSSProperties = {
  ...smallButton,
  color: '#e5484d', borderColor: 'rgba(229,72,77,0.5)',
}
const graphSvg: React.CSSProperties = { width: '100%', height: 160, display: 'block' }

function fmt(t: ExtendedTranslate, key: string, vars: Record<string, string | number>): string {
  let text = t(key)
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

/** 对话 — recent sessions from the global sessions feed. */
function ConversationSection(props: { t: ExtendedTranslate; openSession: (id: SessionId) => void; useSessions: ExtendedPanelProps['useSessions'] }): React.ReactNode {
  const { t, openSession, useSessions } = props
  const sessions = useSessions((state: SessionListState) => state)
  const rows = sessions.ids
    .map((id) => ({ id, summary: sessions.byId[id] }))
    .filter((row) => row.summary !== undefined)
    .sort((a, b) => b.summary!.updatedAt - a.summary!.updatedAt)
    .slice(0, 12)
  if (rows.length === 0) return h('p', { style: muted }, t('conversationEmpty'))
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    ...rows.map(({ id, summary }) => {
      const active = id === sessions.current
      const sessionSummary = summary!
      return h('button', {
        key: id,
        type: 'button',
        style: active ? cardRowActive : cardRow,
        onClick: () => { openSession(id) },
      },
      h('div', { style: { fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sessionSummary.displayTitle),
      h('div', { style: muted }, `${sessionSummary.running ? `${t('conversationRunning')} · ` : ''}${relativeTime(Date.now(), sessionSummary.updatedAt)}`),
      )
    }),
  )
}

/** 知识卡 — knowledge base: search, list, detail, delete. */
function KnowledgeSection(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [cards, setCards] = useState<KnowledgeCardView[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
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

  return h('div', { style: sectionCard },
    h('h3', { style: sectionTitle }, t('knowledgeTitle')),
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
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            h('button', { type: 'button', style: smallButton, onClick: () => { setSelectedId(null) } }, t('knowledgeDetailBack')),
            h('div', { style: { fontSize: 13, fontWeight: 700 } }, detailCard.title),
            h('p', { style: { fontSize: 12, margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' } }, detailCard.summary),
            detailCard.tags.length > 0
              ? h('div', {}, h('span', { style: muted }, `${t('knowledgeTags')}: `), ...detailCard.tags.map((tag) => h('span', { key: tag, style: chip }, tag)))
              : null,
            h('p', { style: muted }, `${t('knowledgeSource')}: ${detailCard.source}`),
            h('p', { style: muted }, `${fmt(t, 'knowledgeUpdated', { time: relativeTime(Date.now(), detailCard.updatedAt) })} · ${fmt(t, 'knowledgeCreated', { time: relativeTime(Date.now(), detailCard.createdAt) })}`),
            deleteError !== '' ? h('p', { style: { ...muted, color: '#e5484d' } }, deleteError) : null,
            confirmingId === detailCard.id
              ? h('div', { style: { display: 'flex', gap: 6 } },
                h('button', { type: 'button', style: dangerButton, disabled: busy, onClick: () => { void remove(detailCard.id) } }, busy ? t('knowledgeDeleteBusy') : t('knowledgeDeleteConfirm')),
                h('button', { type: 'button', style: smallButton, onClick: () => { setConfirmingId(null) } }, t('knowledgeDeleteCancel')),
              )
              : h('div', { style: { display: 'flex', gap: 6 } },
                h('button', { type: 'button', style: dangerButton, onClick: () => { setConfirmingId(detailCard.id) } }, t('knowledgeDelete')),
                h('button', { type: 'button', style: smallButton, onClick: () => { void refreshNow() } }, t('knowledgeRefresh')),
              ),
          )
          : filtered.length === 0
            ? h('p', { style: muted }, query.trim() === '' ? t('knowledgeEmpty') : fmt(t, 'knowledgeSearchEmpty', { query: query.trim() }))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              ...filtered.map((card) => h('button', {
                key: card.id,
                type: 'button',
                style: selectedId === card.id ? cardRowActive : cardRow,
                onClick: () => { setSelectedId(card.id); setDeleteError(''); setConfirmingId(null) },
              },
              h('span', { style: { fontSize: 12, fontWeight: 600 } }, card.title),
              h('span', { style: { fontSize: 11, color: 'var(--dsh-color-text-muted, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, card.summary),
              card.tags.length > 0 ? h('span', {}, ...card.tags.map((tag) => h('span', { key: tag, style: chip }, tag))) : null,
              )),
            ),
  )
}

/** 新闻与知识图谱 — news items plus a tag-derived knowledge graph. */
function NewsGraphSection(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [items, setItems] = useState<NewsItemView[] | null>(null)
  const [cards, setCards] = useState<KnowledgeCardView[]>([])
  const [newsError, setNewsError] = useState('')
  const newsAvailable = useRef(false)

  useEffect(() => {
    let disposed = false
    void (async () => {
      const [news, knowledge] = await Promise.all([fetchNewsItems(), fetchKnowledgeState()])
      if (disposed) return
      if (news !== null) {
        newsAvailable.current = true
        setItems(news)
        setNewsError('')
      } else if (!newsAvailable.current) {
        setNewsError(fmt(t, 'newsLoadError', { error: t('newsRouteUnavailable') }))
      }
      if (knowledge !== null) setCards(knowledge.cards)
    })()
    return () => { disposed = true }
  }, [t])

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

  const graphNode = (index: number): { x: number; y: number } => {
    const center = 80
    const radius = 62
    const angle = (index / Math.max(1, cards.length)) * Math.PI * 2 - Math.PI / 2
    return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) }
  }

  return h('div', { style: sectionCard },
    h('h3', { style: sectionTitle }, t('newsTitle')),
    newsError !== ''
      ? h('p', { style: muted }, newsError)
      : items === null
        ? h('p', { style: muted }, '…')
        : items.length === 0
          ? h('p', { style: muted }, t('newsEmpty'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
            ...items.slice(0, 8).map((item) => {
              const rowStyle: React.CSSProperties = { fontSize: 12, color: 'inherit', display: 'flex', flexDirection: 'column', gap: 2 }
              const body = [
                h('span', { key: 'title', style: { fontWeight: 600 } }, item.title),
                item.summary !== undefined && item.summary !== '' ? h('span', { key: 'summary', style: muted }, item.summary) : null,
                h('span', { key: 'time', style: muted }, relativeTime(Date.now(), item.publishedAt)),
              ]
              return item.url !== undefined && item.url !== ''
                ? h('a', { key: item.id, href: item.url, style: { ...rowStyle, textDecoration: 'none' } }, ...body)
                : h('div', { key: item.id, style: rowStyle }, ...body)
            }),
          ),
    h('h3', { style: { ...sectionTitle, marginTop: 4 } }, t('graphTitle')),
    cards.length < 2
      ? h('p', { style: muted }, t('graphEmpty'))
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('svg', { viewBox: '0 0 160 160', style: graphSvg, role: 'img', 'aria-label': t('graphTitle') },
          ...edges.map((edge, index) => {
            const from = graphNode(edge.a)
            const to = graphNode(edge.b)
            return h('line', {
              key: `edge-${index}`,
              x1: from.x, y1: from.y, x2: to.x, y2: to.y,
              stroke: 'var(--dsh-color-border, rgba(127,127,127,0.45))',
              strokeWidth: 1,
            })
          }),
          ...cards.slice(0, 12).map((card, index) => {
            const point = graphNode(index)
            return h('g', { key: card.id },
              h('circle', { cx: point.x, cy: point.y, r: 10, fill: 'var(--dsh-color-accent, #4c8bf5)', opacity: 0.85 }),
              h('text', {
                x: point.x, y: point.y + 3, textAnchor: 'middle',
                fill: '#fff', fontSize: 7, fontWeight: 700, style: { pointerEvents: 'none' },
              }, String(index + 1)),
            )
          }),
        ),
        h('p', { style: muted }, t('graphHint')),
        edges.length > 0
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4 } },
            ...edges.map((edge, index) => h('span', { key: `tag-${index}`, style: chip }, edge.tag)),
          )
          : null,
      ),
  )
}

/** 专家风格模式 — local-first expert style picker. */
function ExpertStyleSection(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [style, setStyle] = useState<string>(() => {
    try {
      return localStorage.getItem('dsh-desktop.expert-style') ?? 'balanced'
    } catch {
      return 'balanced'
    }
  })
  const modes = [
    { id: 'balanced', label: t('expertBalanced'), desc: t('expertBalancedDesc') },
    { id: 'rigorous', label: t('expertRigorous'), desc: t('expertRigorousDesc') },
    { id: 'creative', label: t('expertCreative'), desc: t('expertCreativeDesc') },
    { id: 'concise', label: t('expertConcise'), desc: t('expertConciseDesc') },
    { id: 'deep', label: t('expertDeep'), desc: t('expertDeepDesc') },
  ]
  const select = (id: string): void => {
    setStyle(id)
    try {
      localStorage.setItem('dsh-desktop.expert-style', id)
    } catch {
      // Persistence is best-effort; the in-memory selection still applies.
    }
  }
  return h('div', { style: sectionCard },
    h('h3', { style: sectionTitle }, t('expertTitle')),
    h('p', { style: muted }, t('expertHint')),
    ...modes.map((mode) => {
      const active = mode.id === style
      return h('button', {
        key: mode.id,
        type: 'button',
        style: active ? cardRowActive : cardRow,
        onClick: () => { select(mode.id) },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { fontSize: 12, fontWeight: 600 } }, mode.label),
        active ? h('span', { style: { fontSize: 11, color: 'var(--dsh-color-accent, #4c8bf5)' } }, '✓') : null,
      ),
      h('span', { style: muted }, mode.desc),
      )
    }),
  )
}

/**
 * The left extended panel. Collapsed (owner `collapsed`) it renders the
 * compact rail of section icons; expanded it stacks the four vertical
 * sections inside a scrollable column.
 */
export function ExtendedPanel(props: ExtendedPanelProps): React.ReactNode {
  const { t, layout, openSession, collapsed, useSessions } = props
  const [railSection, setRailSection] = useState<SectionId>('knowledge')

  if (collapsed) {
    const icons: Array<{ id: SectionId; icon: string; label: string }> = [
      { id: 'conversation', icon: '💬', label: t('railConversation') },
      { id: 'knowledge', icon: '📇', label: t('railKnowledge') },
      { id: 'news', icon: '🗞️', label: t('railNews') },
      { id: 'expert', icon: '🎯', label: t('railExpert') },
    ]
    return h('div', { style: railStyle, role: 'navigation', 'aria-label': t('nav') },
      ...icons.map((icon) => h('button', {
        key: icon.id,
        type: 'button',
        title: icon.label,
        'aria-label': icon.label,
        style: railSection === icon.id ? railButtonActive : railButton,
        onClick: () => {
          setRailSection(icon.id)
          layout.openExtended()
        },
      }, icon.icon)),
    )
  }

  return h('div', { style: surface },
    h('div', { style: headerRow },
      h('h2', { style: headerTitle }, t('nav')),
      h('button', { type: 'button', style: collapseButton, title: t('collapse'), 'aria-label': t('collapse'), onClick: () => { layout.toggleExtended() } }, '«'),
    ),
    h('div', { style: body },
      h(ConversationSection, { t, openSession, useSessions }),
      h(KnowledgeSection, { t }),
      h(NewsGraphSection, { t }),
      h(ExpertStyleSection, { t }),
    ),
  )
}