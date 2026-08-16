import { createElement as h } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type convergence only: locale/theme declarations expose settings slot rows.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { en, zh } from './memory-locales.ts'
import { MemoryPanel, type MemoryTranslate } from './memory-section.tsx'
import { UpdateSidebarAction } from './update-sidebar.tsx'

export { applyAdvancedShell } from './advanced-shell.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

const MEMORY_NS = 'dsh-desktop-memory'

/** Services required by the memory panel and advanced presentation. */
export const inject = [
  'slots',
  'sessions',
  'theme',
  'locale',
]

interface MemoryLocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>, en: Record<string, string> }): unknown
  bind(namespace: string): MemoryTranslate
}

interface MemorySlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: (props?: unknown) => unknown): unknown
}

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const locale = ctx.locale as unknown as MemoryLocaleService
  const slots = ctx.slots as unknown as MemorySlotsService
  locale.register(MEMORY_NS, { zh, en })
  const t = locale.bind(MEMORY_NS)

  // The memory settings section is visible in BOTH desktop modes: it is the
  // user-facing proof that bounded memory and the automatic review are alive.
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'desktop-memory',
    order: 35,
    label: () => t('nav'),
    locale: MEMORY_NS,
    inject: () => ({ t }),
  }, () => h(MemoryPanel, { t })))

  // Sidebar footer "检查更新" action: manual check on click, coexisting with
  // the automatic background checks (and the tray item).
  slots.inject('sidebar.footer.action', () => slots.register({
    name: 'sidebar.footer.action',
    id: 'desktop-updates-check',
    order: 10,
    label: () => 'Check for Updates',
  }, (props: unknown) => h(UpdateSidebarAction, { wide: Boolean((props as { wide?: boolean })?.wide) })))

  const environment = parseDesktopClientEnvironment(window.location.search)
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
}
