/**
 * Memory settings section: live MEMORY.md / USER.md entries, char budgets,
 * pending approval queue, approval toggle, and automatic-review status.
 * Polls the host's /dsh-desktop/memory/state route; mutations POST to the
 * same-origin approve/reject/approval routes.
 */

import { createElement as h, useEffect, useState } from 'react'

const STATE_ROUTE = '/dsh-desktop/memory/state'
const APPROVE_ROUTE = '/dsh-desktop/memory/approve'
const REJECT_ROUTE = '/dsh-desktop/memory/reject'
const APPROVAL_ROUTE = '/dsh-desktop/memory/approval'
const POLL_MS = 2_500

export interface MemoryTranslate {
  (key: string): string
}

interface TargetView {
  target: 'memory' | 'user'
  charCount: number
  charLimit: number
  entries: string[]
}

interface PendingView {
  id: string
  target: 'memory' | 'user'
  origin: string
  createdAt: string
  operations: Array<{ action: string, content?: string, oldText?: string }>
}

interface MemoryState {
  version: number
  approval: boolean
  pending: PendingView[]
  targets: TargetView[]
  review: {
    enabled: boolean
    interval: number
    lastReviewedSecondsAgo: number
    lastRunAt: number
    lastOutcome: string
    lastError: string
  }
}

async function fetchState(): Promise<MemoryState> {
  const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return response.json() as Promise<MemoryState>
}

async function postJson(route: string, body: unknown): Promise<unknown> {
  const response = await fetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new Error(parsed.error ?? String(response.status))
  return parsed
}

function fmt(t: MemoryTranslate, key: string, vars: Record<string, string | number>): string {
  let text = t(key)
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function outcomeLabel(t: MemoryTranslate, outcome: string): string {
  if (outcome === 'ok') return t('outcomeOk')
  if (outcome === 'staged') return t('outcomeStaged')
  if (outcome === 'no-digest') return t('outcomeNoDigest')
  if (outcome === 'no-route') return t('outcomeNoRoute')
  return t('outcomeError')
}

const section: React.CSSProperties = { marginBottom: 20 }
const card: React.CSSProperties = {
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
  borderRadius: 8,
  padding: 12,
  marginBottom: 10,
}
const muted: React.CSSProperties = { color: 'var(--dsh-color-text-muted, #888)', fontSize: 12, marginTop: 6 }
const title: React.CSSProperties = { fontSize: 14, fontWeight: 600, marginBottom: 4 }
const bar: React.CSSProperties = {
  height: 6,
  borderRadius: 3,
  background: 'var(--dsh-color-surface-muted, rgba(127,127,127,0.2))',
  margin: '6px 0',
  overflow: 'hidden',
}
const button: React.CSSProperties = {
  marginRight: 8,
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.4))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

function MemoryPanel(props: { t: MemoryTranslate }): ReturnType<typeof h> {
  const { t } = props
  const [state, setState] = useState<MemoryState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let disposed = false
    const refresh = async (): Promise<void> => {
      try {
        const next = await fetchState()
        if (!disposed) {
          setState(next)
          setError('')
        }
      } catch (cause) {
        if (!disposed) setError(String(cause))
      }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    try {
      setState(await fetchState())
      setError('')
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggleApproval = async (): Promise<void> => {
    setBusy(true)
    try {
      await postJson(APPROVAL_ROUTE, { enabled: !state?.approval })
      await refresh()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const approve = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await postJson(APPROVE_ROUTE, { id })
      await refresh()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const reject = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await postJson(REJECT_ROUTE, { id })
      await refresh()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (state === null) {
    return h('div', { style: section },
      error === '' ? h('div', { style: muted }, '…') : h('div', { style: muted }, fmt(t, 'loadError', { error })),
    )
  }

  const review = state.review
  const reviewLine = review.lastReviewedSecondsAgo < 0
    ? t('reviewNever')
    : fmt(t, 'reviewLast', { sec: review.lastReviewedSecondsAgo, outcome: outcomeLabel(t, review.lastOutcome) })

  return h('div', { style: section },
    h('div', { style: card },
      h('div', { style: title }, review.enabled ? t('reviewOn') : t('reviewOff')),
      h('div', { style: muted }, `${fmt(t, 'reviewEvery', { n: review.interval })} · ${reviewLine}${review.lastError !== '' ? ` · ${review.lastError}` : ''}`),
      h('div', { style: { marginTop: 8 } },
        h('button', { style: button, disabled: busy, onClick: () => { void toggleApproval() } }, t('toggleApproval')),
        h('span', { style: muted }, state.approval ? t('approvalOn') : t('approvalOff')),
      ),
    ),
    ...state.targets.map(target => {
      const width = target.charLimit === 0 ? 0 : Math.min(100, target.charCount / target.charLimit * 100)
      return h('div', { key: target.target, style: card },
        h('div', { style: title }, target.target === 'memory' ? t('memoryTitle') : t('userTitle')),
        h('div', { style: bar }, h('div', { style: { width: `${width}%`, height: '100%', background: 'var(--dsh-color-accent, #4c8bf5)' } })),
        h('div', { style: muted }, fmt(t, 'usage', { count: target.charCount, limit: target.charLimit, entries: target.entries.length })),
        target.entries.length === 0
          ? h('div', { style: { marginTop: 8, fontSize: 12 } }, fmt(t, 'empty', { n: review.interval }))
          : h('ol', { style: { margin: '8px 0 0', paddingLeft: 18 } },
            ...target.entries.map(entry => h('li', { key: entry, style: { fontSize: 12, marginBottom: 4 } }, entry))),
      )
    }),
    h('div', { style: card },
      h('div', { style: title }, t('pendingTitle')),
      ...(state.pending.length === 0
        ? [h('div', { key: 'pending-empty', style: muted }, t('pendingEmpty'))]
        : state.pending.map(pending => h('div', { key: pending.id, style: { marginBottom: 8, fontSize: 12 } },
          h('div', { style: muted }, `${pending.id} · ${pending.target} · ${t('origin')}=${pending.origin}`),
          h('div', {}, pending.operations.map(op => `${op.action} ${op.content ?? op.oldText ?? ''}`).join('; ')),
          h('div', { style: { marginTop: 4 } },
            h('button', { style: button, disabled: busy, onClick: () => { void approve(pending.id) } }, t('approve')),
            h('button', { style: button, disabled: busy, onClick: () => { void reject(pending.id) } }, t('reject')),
          ),
        ))),
    ),
    h('div', { style: section },
      h('button', { style: button, disabled: busy, onClick: () => { void refresh() } }, t('refresh')),
      error === '' ? null : h('span', { style: muted }, ` ${fmt(t, 'loadError', { error })}`),
    ),
  )
}

export { MemoryPanel }
