/**
 * Compatibility-mode extended workspace host.
 *
 * The ExtendedPanel itself owns the full-page workspace (fixed overlay when
 * expanded, compact rail when collapsed). This module only supplies the
 * open/close state persisted in localStorage, keeps the upstream AppFrame
 * clear of the collapsed rail with a small `#root` margin, and registers the
 * panel into the additive `shell.overlay` layer the upstream frame always
 * mounts.
 *
 * Advanced mode keeps `panel.extended` untouched: this module only runs when
 * `parseDesktopClientEnvironment` reports `compatibility`, so the two
 * registrations can never double-mount the panel in one window.
 */

import { createElement as h, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DesktopClientEnvironment } from './environment.ts'
import type {} from './contracts.ts'
import { installCompatibilityStyles } from './styles.ts'
import { EXTENDED_NS } from './extended-locales.ts'
import { ExtendedPanel, type ExtendedLayoutControl, type ExtendedTranslate } from './extended-panel.tsx'
import { mountOfficeDeskTheme } from './office-desk-theme.ts'

const EXTENDED_COLLAPSED = 56

/** Business face delivered to the compatibility dock registration. */
export interface CompatibilityExtendedInjected {
  t: ExtendedTranslate
  /** Open/close control backed by the dock's local state. */
  layout: ExtendedLayoutControl
  /** Open one session from the 对话 section. */
  openSession: (id: SessionId) => void
}

export type CompatibilityExtendedProps = PropsRuntime<'shell.overlay'> & CompatibilityExtendedInjected

/**
 * Hosts the user-authored Office Desk theme in a full-screen `srcdoc`
 * iframe (theme file untouched) with all Desktop features wired through the
 * bridge adapter. If theme mounting ever throws, the shared ExtendedPanel
 * remains the fallback so the workspace can never be blank.
 */
export function CompatibilityExtendedDock(props: CompatibilityExtendedProps): React.ReactNode {
  const { t, openSession, useSessions } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    if (fallback) return
    const container = containerRef.current
    if (container === null) return
    let dispose: (() => void) | undefined
    try {
      dispose = mountOfficeDeskTheme(container, {
        mode: document.body.dataset.dshDesktopMode ?? 'compatibility',
        platform: document.body.dataset.dshDesktopPlatform ?? 'win32',
      })
    } catch {
      setFallback(true)
      return
    }
    return () => dispose?.()
  }, [fallback])

  if (fallback) {
    const layout: ExtendedLayoutControl = { toggleExtended: () => undefined, openExtended: () => undefined }
    return h(ExtendedPanel, { t, layout, openSession, collapsed: false, width: EXTENDED_COLLAPSED, useSessions })
  }

  return h('div', {
    ref: containerRef,
    style: { position: 'fixed', inset: 0, zIndex: 1000 },
  })
}

/**
 * Register the compatibility extended workspace for one plugin-fiber lifetime.
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
