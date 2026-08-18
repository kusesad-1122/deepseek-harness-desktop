/**
 * Focused desktop extension navigator shared by compatibility and advanced
 * shells. The home view exposes clickable projects; each project's controls
 * and data mount only after the user opens it.
 */

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopLayoutService } from './contracts.ts'
import {
  deleteKnowledgeCard, fetchDailyNews, fetchKnowledgeState, relativeTime,
} from './knowledge-client.ts'
import type { DailyNewsFeedView, KnowledgeCardView } from './knowledge-client.ts'

export interface ExtendedTranslate {
  (key: string): string
}

/** Business face provided to the extended panel registration. */
export interface ExtendedPanelInjected {
  t: ExtendedTranslate
  layout: DesktopLayoutService
}

export type ExtendedPanelProps = PropsRuntime<'panel.extended'> & ExtendedPanelInjected

type ProjectId = 'conversation' | 'knowledge' | 'news' | 'graph' | 'expert'
type PanelView = ProjectId

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
const graphSvg: React.CSSProperties = { width: '100%', height: 180, display: 'block' }
const projectButton: React.CSSProperties = {
  width: '100%', minHeight: 64, boxSizing: 'border-box', display: 'grid',
  gridTemplateColumns: '32px minmax(0, 1fr) 18px', alignItems: 'center', gap: 10,
  padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
  background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer', font: 'inherit',
}
const projectButtonActive: React.CSSProperties = { ...projectButton, borderColor: 'var(--dsh-color-accent, #4c8bf5)', background: 'var(--dsh-color-surface-muted, rgba(127,127,127,0.12))' }
const backButton: React.CSSProperties = { width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 18, padding: 0 }
const projectIcon: React.CSSProperties = { width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }
const projectCopy: React.CSSProperties = { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }
const projectLabel: React.CSSProperties = { fontSize: 13, fontWeight: 650 }
const projectDescription: React.CSSProperties = { color: 'var(--dsh-color-text-muted, #888)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const projectContent: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }

function fmt(t: ExtendedTranslate, key: string, vars: Record<string, string | number>): string {
  let text = t(key)
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value))
  return text
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

  return h('div', { style: projectContent },
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

/** 每日热点新闻 — loaded only after the project opens. */
function DailyNewsSection(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [feed, setFeed] = useState<DailyNewsFeedView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = async (force: boolean): Promise<void> => {
    setBusy(true)
    const next = await fetchDailyNews(force)
    if (next === null) setLoadError(t('dailyNewsUnavailable'))
    else { setFeed(next); setLoadError('') }
    setBusy(false)
  }

  useEffect(() => { void refresh(false) }, [])

  if (loadError !== '') return h('div', { style: projectContent },
    h('p', { style: muted }, loadError),
    h('button', {
      type: 'button', style: smallButton, disabled: busy,
      onClick: () => { void refresh(true) },
    }, busy ? t('dailyNewsRefreshing') : t('dailyNewsRetry')),
  )
  if (feed === null) return h('p', { style: muted }, '…')
  return h('div', { style: projectContent },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
      h('p', { style: muted }, fmt(t, 'dailyNewsMeta', { source: feed.source, date: feed.date })),
      h('button', {
        type: 'button', style: smallButton, disabled: busy,
        onClick: () => { void refresh(true) },
      }, busy ? t('dailyNewsRefreshing') : t('dailyNewsRefresh')),
    ),
    h('ol', { style: { margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 } },
      ...feed.items.map((item) => h('li', { key: item.id, style: { paddingLeft: 2 } },
        h('a', {
          href: item.url ?? feed.sourceUrl, target: '_blank', rel: 'noreferrer',
          style: { fontSize: 12, lineHeight: 1.5, color: 'inherit', textDecoration: 'none' },
        }, item.title),
      )),
    ),
    h('a', {
      href: feed.sourceUrl, target: '_blank', rel: 'noreferrer',
      style: { ...smallButton, textDecoration: 'none', alignSelf: 'flex-start' },
    }, t('dailyNewsOpenSource')),
  )
}

/** 知识图谱 — tag-derived relationships between knowledge cards. */
function KnowledgeGraphSection(props: { t: ExtendedTranslate }): React.ReactNode {
  const { t } = props
  const [cards, setCards] = useState<KnowledgeCardView[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void fetchKnowledgeState().then((state) => { if (!disposed) setCards(state?.cards ?? []) })
    return () => { disposed = true }
  }, [])

  const limited = (cards ?? []).slice(0, 12)
  const edges = useMemo(() => {
    const result: Array<{ a: number; b: number; tag: string }> = []
    for (let i = 0; i < limited.length; i += 1) {
      for (let j = i + 1; j < limited.length; j += 1) {
        const shared = limited[i]!.tags.find((tag) => limited[j]!.tags.includes(tag))
        if (shared !== undefined) result.push({ a: i, b: j, tag: shared })
      }
    }
    return result
  }, [cards])
  const point = (index: number): { x: number; y: number } => {
    const angle = (index / Math.max(1, limited.length)) * Math.PI * 2 - Math.PI / 2
    return { x: 90 + 70 * Math.cos(angle), y: 90 + 70 * Math.sin(angle) }
  }
  const selected = limited.find((card) => card.id === selectedId) ?? null

  if (cards === null) return h('p', { style: muted }, '…')
  if (limited.length < 2) return h('p', { style: muted }, t('graphEmpty'))
  return h('div', { style: projectContent },
    h('svg', { viewBox: '0 0 180 180', style: graphSvg, role: 'img', 'aria-label': t('graphTitle') },
      ...edges.map((edge, index) => {
        const from = point(edge.a); const to = point(edge.b)
        return h('line', {
          key: `edge-${index}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y,
          stroke: 'var(--dsh-color-border, rgba(127,127,127,0.45))', strokeWidth: 1,
        })
      }),
      ...limited.map((card, index) => {
        const node = point(index); const active = card.id === selectedId
        return h('g', {
          key: card.id, role: 'button', tabIndex: 0, style: { cursor: 'pointer' },
          onClick: () => { setSelectedId(card.id) },
          onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setSelectedId(card.id)
            }
          },
        },
        h('circle', {
          cx: node.x, cy: node.y, r: active ? 13 : 11,
          fill: 'var(--dsh-color-accent, #4c8bf5)', opacity: active ? 1 : 0.82,
        }),
        h('text', {
          x: node.x, y: node.y + 3, textAnchor: 'middle', fill: '#fff',
          fontSize: 7, fontWeight: 700, style: { pointerEvents: 'none' },
        }, String(index + 1)),
        )
      }),
    ),
    h('p', { style: muted }, t('graphHint')),
    ...limited.map((card, index) => h('button', {
      key: card.id, type: 'button', style: card.id === selectedId ? cardRowActive : cardRow,
      onClick: () => { setSelectedId(card.id) },
    },
    h('span', { style: { fontSize: 12, fontWeight: 600 } }, `${String(index + 1)}. ${card.title}`),
    card.tags.length > 0 ? h('span', {}, ...card.tags.map((tag) => h('span', { key: tag, style: chip }, tag))) : null,
    )),
    selected !== null ? h('div', { style: sectionCard },
      h('div', { style: { fontSize: 13, fontWeight: 700 } }, selected.title),
      h('p', { style: { fontSize: 12, margin: 0, lineHeight: 1.5 } }, selected.summary),
    ) : null,
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
  return h('div', { style: projectContent },
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

/** Render the extension project home menu. */
function ProjectMenu(props: { t: ExtendedTranslate; active: PanelView; open: (id: ProjectId) => void }): React.ReactNode {
  const { t, active, open } = props
  const projects: Array<{ id: ProjectId; icon: string; label: string; description: string }> = [
    { id: 'conversation', icon: '💬', label: t('conversationTitle'), description: t('conversationProjectDesc') },
    { id: 'knowledge', icon: '📇', label: t('knowledgeTitle'), description: t('knowledgeProjectDesc') },
    { id: 'news', icon: '📰', label: t('dailyNewsTitle'), description: t('dailyNewsProjectDesc') },
    { id: 'graph', icon: '◉', label: t('graphTitle'), description: t('graphProjectDesc') },
    { id: 'expert', icon: '◎', label: t('expertTitle'), description: t('expertProjectDesc') },
  ]
  return h('div', { style: projectContent }, ...projects.map((project) => h('button', {
    key: project.id,
    type: 'button',
    style: project.id === active ? projectButtonActive : projectButton,
    onClick: () => { open(project.id) },
  },
  h('span', { style: projectIcon, 'aria-hidden': true }, project.icon),
  h('span', { style: projectCopy },
    h('span', { style: projectLabel }, project.label),
    h('span', { style: projectDescription }, project.description),
  ),
  h('span', { style: { color: 'var(--dsh-color-text-muted, #888)', textAlign: 'right' }, 'aria-hidden': true }, '›'),
  )))
}

function projectTitle(t: ExtendedTranslate, view: PanelView): string {
  if (view === 'knowledge') return t('knowledgeTitle')
  if (view === 'news') return t('dailyNewsTitle')
  if (view === 'graph') return t('graphTitle')
  if (view === 'expert') return t('expertTitle')
  return t('conversationTitle')
}

function projectPageLeft(width: number): number {
  const root = document.getElementById('root')
  const rootLeft = root?.getBoundingClientRect().left ?? 0
  const frame = root?.querySelector('.dshDesktopFrame')
  const extended = frame?.querySelector('.dshDesktopExtendedSurface')
  const extendedWidth = extended?.getBoundingClientRect().width ?? 0
  const sidebarSlot = root?.querySelector('[data-slot="sidebar"]')
  const sidebarColumn = sidebarSlot?.parentElement
  const sidebarWidth = sidebarColumn?.getBoundingClientRect().width ?? 280
  // Leave both the extension dock and the ordinary conversation sidebar visible.
  return Math.max(width, rootLeft + extendedWidth + sidebarWidth)
}

function useProjectPageLeft(width: number, view: PanelView): number {
  const [left, setLeft] = useState(width)
  useEffect(() => {
    if (view === 'conversation') return
    const update = (): void => { setLeft(projectPageLeft(width)) }
    update()
    window.addEventListener('resize', update)
    const root = document.getElementById('root')
    const observer = typeof ResizeObserver === 'undefined' || root === null
      ? undefined
      : new ResizeObserver(update)
    if (observer !== undefined && root !== null) observer.observe(root)
    return () => {
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [view, width])
  return left
}

function DesktopProjectPage(props: {
  t: ExtendedTranslate
  view: Exclude<PanelView, 'conversation'>
  left: number
  onBack: () => void
}): React.ReactNode {
  const { t, view, left, onBack } = props
  const content = view === 'knowledge'
    ? h(KnowledgeSection, { t })
    : view === 'news'
      ? h(DailyNewsSection, { t })
      : view === 'graph'
        ? h(KnowledgeGraphSection, { t })
        : h(ExpertStyleSection, { t })
  return h('div', {
    className: 'dshDesktopProjectPage',
    style: {
      position: 'fixed', left, top: 0, right: 0, bottom: 0, zIndex: 900,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-fg-base, inherit)',
    },
  },
  h('header', {
    style: {
      minHeight: 52, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 24px', borderBottom: '1px solid var(--dsh-color-border, rgba(127,127,127,0.28))',
    },
  },
  h('button', {
    type: 'button', title: t('back'), 'aria-label': t('back'), style: backButton,
    onClick: onBack,
  }, '‹'),
  h('h1', { style: { fontSize: 18, fontWeight: 700, margin: 0 } }, projectTitle(t, view)),
  ),
  h('main', {
    style: {
      flex: '1 1 auto', overflowY: 'auto', padding: '28px 32px 48px',
      display: 'flex', justifyContent: 'flex-start',
    },
  },
  h('div', { style: { width: 'min(100%, 960px)', display: 'flex', flexDirection: 'column', gap: 12 } }, content),
  ),
  )
}

/** Left project navigator; non-conversation projects render as full main pages. */
export function ExtendedPanel(props: ExtendedPanelProps): React.ReactNode {
  const { t, layout, collapsed, width = 300 } = props
  const [view, setView] = useState<PanelView>('conversation')
  const pageLeft = useProjectPageLeft(width, view)
  const projects: Array<{ id: ProjectId; icon: string; label: string }> = [
    { id: 'conversation', icon: '💬', label: t('conversationTitle') },
    { id: 'knowledge', icon: '📇', label: t('knowledgeTitle') },
    { id: 'news', icon: '📰', label: t('dailyNewsTitle') },
    { id: 'graph', icon: '◉', label: t('graphTitle') },
    { id: 'expert', icon: '◎', label: t('expertTitle') },
  ]
  const open = (project: ProjectId): void => { setView(project) }

  const dock = collapsed
    ? h('div', { style: railStyle, role: 'navigation', 'aria-label': t('nav') },
      ...projects.map((project) => h('button', {
        key: project.id, type: 'button', title: project.label, 'aria-label': project.label,
        style: view === project.id ? railButtonActive : railButton,
        onClick: () => { open(project.id); layout.openExtended() },
      }, project.icon)),
    )
    : h('div', { style: surface },
      h('div', { style: headerRow },
        h('h2', { style: headerTitle }, t('nav')),
        h('button', {
          type: 'button', style: collapseButton, title: t('collapse'), 'aria-label': t('collapse'),
          onClick: () => { layout.toggleExtended() },
        }, '«'),
      ),
      h('div', { style: body },
        h(ProjectMenu, { t, active: view, open }),
      ),
    )

  if (view === 'conversation') return dock
  return h('div', {}, dock, createPortal(
    h(DesktopProjectPage, {
      t, view, left: pageLeft, onBack: () => { setView('conversation') },
    }),
    document.body,
  ))
}
