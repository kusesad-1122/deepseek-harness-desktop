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

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DesktopClientEnvironment } from './environment.ts'
import type {} from './contracts.ts'
import { installCompatibilityStyles } from './styles.ts'
import { EXTENDED_NS } from './extended-locales.ts'
import { ExtendedPanel, type ExtendedLayoutControl, type ExtendedTranslate } from './extended-panel.tsx'
import { mountOfficeDeskTheme, type OfficeDeskThemeMount } from './office-desk-theme.ts'

const EXTENDED_COLLAPSED = 56
const EXTENDED_EXPANDED = 320

/** Whether a native conversation can be revealed without blanking the theme. */
export function shouldRevealNativeSession(sessionId: SessionId | undefined): sessionId is SessionId {
  return sessionId !== undefined
}

/**
 * Locate the upstream settings trigger without mistaking another dialog
 * trigger (for example, the context meter or feedback note) for settings.
 * The compact sidebar trigger has no visible label, so its settings-area
 * ancestor is also accepted as a stable structural marker.
 */
export function findNativeSettingsTrigger(root: ParentNode): HTMLElement | null {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(
    '[data-settings-trigger], [data-slot="settings.trigger"], button[aria-haspopup="dialog"], [role="button"][aria-haspopup="dialog"], button, [role="button"]',
  ))
  let best: { element: HTMLElement, score: number } | undefined
  for (const element of candidates) {
    let score = 0
    if (element.getAttribute('data-settings-trigger') !== null || element.getAttribute('data-slot') === 'settings.trigger') {
      score = 1000
    }

    // CSS-module class names retain their local suffix across builds, while
    // the generated prefix is intentionally free to change.
    if (typeof element.closest === 'function' && element.closest('[class*="settingsArea"], [class*="settings-area"]') !== null) {
      score = Math.max(score, 900)
    }

    const label = `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.textContent ?? ''}`
      .trim()
      .toLocaleLowerCase()
    if (/settings?|设置|偏好|配置|preferences?|param[eè]tres?/.test(label)) score = Math.max(score, 800)

    if (score === 0) continue
    if (best === undefined || score > best.score) best = { element, score }
  }
  return best?.element ?? null
}

/** Business face delivered to the compatibility dock registration. */
export interface CompatibilityExtendedInjected {
  t: ExtendedTranslate
  /** Open/close control backed by the dock's local state. */
  layout: ExtendedLayoutControl
  /** Open one session from the 对话 section. */
  openSession: (id: SessionId) => void
}

export type CompatibilityExtendedProps = PropsRuntime<'shell.overlay'> & CompatibilityExtendedInjected

interface CompatibilityClientBridge {
  readonly locale: { bind(namespace: string): ExtendedTranslate }
  readonly sessions: { open(id: SessionId): void }
}

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
 * Hosts the user-authored Office Desk theme. The theme is loaded verbatim in
 * an iframe; all behavior enters through the bridge in office-desk-theme.ts.
 * A compact native rail is retained solely as a runtime-failure fallback.
 */
export function CompatibilityExtendedDock(props: CompatibilityExtendedProps): React.ReactNode {
  const { t, openSession, useSessions } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mountRef = useRef<OfficeDeskThemeMount | null>(null)
  const openSessionRef = useRef(openSession)
  openSessionRef.current = openSession
  const activeSession = useSessions((sessions) => sessions.current)
  const activeSessionRef = useRef(activeSession)
  activeSessionRef.current = activeSession
  const [fallback, setFallback] = useState(false)
  const [fallbackCollapsed, setFallbackCollapsed] = useState(true)

  const revealNativeConversation = useCallback(() => {
    const sessionId = activeSessionRef.current
    if (!shouldRevealNativeSession(sessionId)) return
    mountRef.current?.setVisible(false)
    openSessionRef.current(sessionId)
  }, [])

  const revealNativeSettings = useCallback(() => {
    requestAnimationFrame(() => {
      try {
        const candidate = findNativeSettingsTrigger(document)
        if (candidate === null) {
          // Keep the theme usable when a host shell has no settings surface.
          mountRef.current?.setVisible(true)
          return
        }
        mountRef.current?.setVisible(false)
        candidate.click()
      } catch {
        mountRef.current?.setVisible(true)
      }
    })
  }, [])

  useEffect(() => {
    if (fallback) return
    const container = containerRef.current
    if (container === null) return
    try {
      mountRef.current = mountOfficeDeskTheme(container, {
        mode: document.body.dataset.dshDesktopMode ?? 'compatibility',
        platform: document.body.dataset.dshDesktopPlatform ?? 'win32',
        openNativeConversation: revealNativeConversation,
        openNativeSettings: revealNativeSettings,
      })
    } catch {
      setFallback(true)
    }
    return () => {
      mountRef.current?.dispose()
      mountRef.current = null
    }
  }, [fallback, revealNativeConversation, revealNativeSettings])

  useEffect(() => {
    const root = document.querySelector<HTMLElement>('#root')
    if (root === null) return
    if (!fallback) {
      root.style.removeProperty('--dsh-compat-root-offset')
      return
    }
    root.style.setProperty('--dsh-compat-root-offset', `${fallbackCollapsed ? EXTENDED_COLLAPSED : EXTENDED_EXPANDED}px`)
    return () => { root.style.removeProperty('--dsh-compat-root-offset') }
  }, [fallback, fallbackCollapsed])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        mountRef.current?.setVisible(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (fallback) {
    const fallbackLayout: ExtendedLayoutControl = {
      toggleExtended: () => setFallbackCollapsed((current) => !current),
      openExtended: () => setFallbackCollapsed(false),
    }
    const fallbackWidth = fallbackCollapsed ? EXTENDED_COLLAPSED : EXTENDED_EXPANDED
    return h('div', { className: 'dshDesktopCompatDock', style: dockStyle(fallbackWidth) },
      h(ExtendedPanel, {
        t,
        layout: fallbackLayout,
        openSession,
        collapsed: fallbackCollapsed,
        width: fallbackWidth,
        useSessions,
      }),
    )
  }
  return h('div', { className: 'dshDesktopCompatDock dshOfficeDeskThemeHost', ref: containerRef })
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
    const client = ctx as unknown as CompatibilityClientBridge
    const extendedT = client.locale.bind(EXTENDED_NS)
    return ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'desktop-extended',
      order: 10,
      inject: () => ({
        t: extendedT,
        layout: { toggleExtended: () => undefined, openExtended: () => undefined },
        openSession: (id: SessionId) => { client.sessions.open(id) },
      }),
    }, CompatibilityExtendedDock))
  }, 'desktop: compatibility extended dock')
}
