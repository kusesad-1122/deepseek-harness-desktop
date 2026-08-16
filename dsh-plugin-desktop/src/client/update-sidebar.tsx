/**
 * Sidebar footer action: "检查更新" — POSTs the host's manual check route so
 * the click runs the exact same flow as the tray item (styled update dialog
 * when an update exists, native "up to date" otherwise).
 */

import { createElement as h, useState } from 'react'

const CHECK_ROUTE = '/dsh-desktop/updates/check'

const zh = {
  check: '检查更新',
  checking: '检查中…',
  fail: '检查更新失败',
}

type TKey = keyof typeof zh

function t(key: TKey): string {
  return zh[key]
}

interface SidebarFooterActionOwnerProps {
  wide: boolean
}

const wideRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '7px 10px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 13,
  cursor: 'pointer',
  borderRadius: 6,
}
const railButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 36,
  height: 36,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  fontSize: 16,
  cursor: 'pointer',
  borderRadius: 6,
}

function UpdateSidebarAction(props: SidebarFooterActionOwnerProps): ReturnType<typeof h> {
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const response = await fetch(CHECK_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!response.ok) throw new Error(String(response.status))
    } catch {
      // The host surfaces failures through its own dialogs; a network miss here
      // is silent to avoid double-reporting.
    } finally {
      setBusy(false)
    }
  }
  const glyph = busy ? '…' : '↻'
  const label = busy ? t('checking') : t('check')
  if (!props.wide) {
    return h('button', { style: railButton, title: label, disabled: busy, onClick: () => { void run() } }, glyph)
  }
  return h('button', { style: wideRow, disabled: busy, onClick: () => { void run() } },
    h('span', { style: { width: 16, textAlign: 'center' } }, glyph),
    h('span', {}, label),
  )
}

export { UpdateSidebarAction }
