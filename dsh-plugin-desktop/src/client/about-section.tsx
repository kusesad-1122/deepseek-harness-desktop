/**
 * About settings section: a short introduction to the DSH Desktop (DeepSeek
 * Harness) app plus a manual "检查更新" action. The action POSTs the host's
 * manual check route so the click runs the exact same flow as the tray item
 * (styled update dialog when an update exists, native "up to date" otherwise).
 * The installed version and the live check/download state come from the
 * /dsh-desktop/updates/state route.
 */

import { createElement as h, useEffect, useState } from 'react'

const CHECK_ROUTE = '/dsh-desktop/updates/check'
const STATE_ROUTE = '/dsh-desktop/updates/state'
const POLL_MS = 2_500

export interface AboutTranslate {
  (key: string): string
}

interface UpdateState {
  currentVersion?: string
  checking: boolean
  downloadingVersion: string | null
  downloadPercent: number | null
  available: { version: string } | null
}

const section: React.CSSProperties = { marginBottom: 20 }
const card: React.CSSProperties = {
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
  borderRadius: 8,
  padding: 14,
  marginBottom: 10,
}
const title: React.CSSProperties = { fontSize: 15, fontWeight: 700, marginBottom: 6 }
const para: React.CSSProperties = { fontSize: 13, lineHeight: 1.6, margin: '0 0 8px' }
const muted: React.CSSProperties = { color: 'var(--dsh-color-text-muted, #888)', fontSize: 12, marginTop: 6 }
const button: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 6,
  border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.4))',
  background: 'var(--dsh-color-accent, #4c8bf5)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 13,
}

function fmt(t: AboutTranslate, key: string, vars: Record<string, string | number>): string {
  let text = t(key)
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function AboutPanel(props: { t: AboutTranslate }): ReturnType<typeof h> {
  const { t } = props
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<UpdateState | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        const next = await response.json() as UpdateState
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

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const response = await fetch(CHECK_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) throw new Error(String(response.status))
      // The host surfaces its own dialogs; refresh the inline status after it
      // settles so the row reflects the just-completed check.
      const next = await fetch(STATE_ROUTE, { cache: 'no-store' })
        .then(r => r.json() as Promise<UpdateState>)
      setState(next)
      setError('')
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const version = state?.currentVersion ?? ''
  const statusLine = ((): string | null => {
    if (state === null) return null
    if (state.downloadingVersion !== null) {
      const percent = state.downloadPercent === null ? '' : ` ${state.downloadPercent}%`
      return fmt(t, 'downloading', { version: state.downloadingVersion, percent })
    }
    if (state.checking || busy) return t('checking')
    if (state.available !== null) return fmt(t, 'updateAvailable', { version: state.available.version })
    return t('upToDate')
  })()

  return h('div', { style: section },
    h('div', { style: card },
      h('div', { style: title }, t('title')),
      h('p', { style: para }, t('intro')),
      h('div', { style: muted }, version === '' ? '…' : fmt(t, 'version', { version })),
      h('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 } },
        h('button', {
          style: button,
          disabled: busy || Boolean(state?.checking),
          onClick: () => { void run() },
        }, busy ? t('checking') : t('check')),
        statusLine === null ? null : h('span', { style: muted }, statusLine),
      ),
      error === '' ? null : h('div', { style: muted }, fmt(t, 'checkFail', { error })),
    ),
  )
}

export { AboutPanel }
