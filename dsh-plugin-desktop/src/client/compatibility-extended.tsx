/**
 * Compatibility-mode left extended panel: the SAME ExtendedPanel surface the
 * advanced root hosts inside its `panel.extended` column, shown by default in
 * the plain upstream shell (no mode switch required).
 *
 * The compatibility shell has no desktop root frame — ui-layout's AppFrame
 * occupies `root` and only declares `sidebar | conversation | details |
 * shell.overlay`. So instead of owning a grid column, the panel registers into
 * `shell.overlay` (the additive, click-through layer the frame always mounts)
 * and renders as a fixed-position left dock. The dock is `position: fixed` on
 * the VIEWPORT, so it ignores the app's own box; the app is shifted right by
 * the dock width through a `#root` margin-left owned by this effect. The
 * upstream frame's ResizeObserver then re-solves its columns against the
 * narrower box, giving the same [extended | sidebar | conversation | details]
 * reading order as advanced mode without touching AppFrame.
 */

import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DesktopClientEnvironment } from './environment.ts'
import type {} from './contracts.ts'
import { installCompatibilityStyles } from './styles.ts'
import { EXTENDED_NS } from './extended-locales.ts'
import { ExtendedPanel, type ExtendedLayoutControl, type ExtendedTranslate } from './extended-panel.tsx'

/** localStorage key remembering the user's collapse choice (default = wide). */
const COMPAT_EXTENDED_PREF = 'dsh-desktop.compat-extended'
const EXTENDED_COLLAPSED = 56
const EXTENDED_DEFAULT = 300

/** Business face delivered to the compatibility dock registration. */
export interface CompatibilityExtendedInjected {
  t: ExtendedTranslate
  /** Open/close control backed by the dock's local state. */
  layout: ExtendedLayoutControl
  /** Open one session from the 对话 section. */
  openSession: (id: SessionId) => void
}

export type CompatibilityExtendedProps = PropsRuntime<'shell.overlay'> & CompatibilityExtendedInjected

function dockStyle(width: number): React.CSSProperties {
  return {
    position: 'fixed',
    left: 0,
    top: 0,
    bottom: 0,
    width,
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  }
}

/**
 * Fixed left dock hosting the shared ExtendedPanel. The dock owns its own
 * collapsed/width state (persisted in localStorage) and mirrors the rendered
 * width into a `#root` margin so the upstream AppFrame never sits underneath it.
 */
export function CompatibilityExtendedDock(props: CompatibilityExtendedProps): React.ReactNode {
  const { t, openSession, useSessions } = props
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COMPAT_EXTENDED_PREF) === 'rail'
    } catch {
      return false
    }
  })
  const width = collapsed ? EXTENDED_COLLAPSED : EXTENDED_DEFAULT
  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev
      try {
        localStorage.setItem(COMPAT_EXTENDED_PREF, next ? 'rail' : 'wide')
      } catch {
        // Persistence is best-effort; the in-memory state still applies.
      }
      return next
    })
  }, [])
  const open = useCallback(() => setCollapsed(false), [])
  const layout = useMemo(() => ({ toggleExtended: toggle, openExtended: open }), [toggle, open])

  // Shift the whole app right by the dock width. `position: fixed` docks are
  // viewport-anchored, so the margin only moves the frame content; the
  // cleanup restores the plain upstream layout when the fiber unloads.
  useEffect(() => {
    const root = document.getElementById('root')
    if (root === null) return
    root.style.marginLeft = `${width}px`
    return () => { root.style.marginLeft = '' }
  }, [width])

  return h('div', { className: 'dshDesktopCompatDock', style: dockStyle(width) },
    h(ExtendedPanel, { t, layout, openSession, collapsed, width, useSessions }),
  )
}

/**
 * Register the compatibility extended dock for one plugin-fiber lifetime.
 * @param ctx - active browser Cordis context.
 * @param environment - validated mode and platform marker (mode === 'compatibility').
 */
export function applyCompatibilityExtended(ctx: ClientContext, environment: DesktopClientEnvironment): void {
  if (environment.mode !== 'compatibility') {
    throw new Error(`dsh-plugin-desktop: compatibility shell received mode ${JSON.stringify(environment.mode)}`)
  }

  ctx.effect(() => {
    document.body.dataset.dshDesktopMode = 'compatibility'
    document.body.dataset.dshDesktopPlatform = environment.platform
    const removeStyles = installCompatibilityStyles()
    return () => {
      removeStyles()
      delete document.body.dataset.dshDesktopMode
      delete document.body.dataset.dshDesktopPlatform
    }
  }, 'desktop: compatibility shell styles')

  ctx.effect(() => {
    const extendedT = (ctx.locale as unknown as { bind(ns: string): ExtendedTranslate }).bind(EXTENDED_NS)
    return ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'desktop-extended',
      order: 10,
      inject: () => ({
        t: extendedT,
        layout: { toggleExtended: () => undefined, openExtended: () => undefined },
        openSession: (id: SessionId) => { ctx.sessions.open(id) },
      }),
    }, CompatibilityExtendedDock))
  }, 'desktop: compatibility extended dock')
}
