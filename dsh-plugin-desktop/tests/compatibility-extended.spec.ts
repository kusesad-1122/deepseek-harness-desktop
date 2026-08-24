import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  CompatibilityExtendedDock,
  findNativeSettingsTrigger,
  shouldRevealNativeSession,
  type CompatibilityExtendedProps,
} from '../src/client/compatibility-extended.tsx'
import {
  closeReaderDialogButtons,
  scopedPageSelector,
} from '../src/client/office-desk-theme.ts'
import { officeDeskThemeHtmlForRuntime } from '../src/client/office-desk-theme-data.ts'

describe('CompatibilityExtendedDock', () => {
  it('hosts the Office Desk theme without adding a second navigation tree', () => {
    const markup = renderToStaticMarkup(h(CompatibilityExtendedDock, {
      t: (key: string) => key,
      layout: { toggleExtended: () => undefined, openExtended: () => undefined },
      openSession: () => undefined,
      useSessions: (selector) => selector({ byId: {}, ids: [], current: undefined } as never),
      useWorkspaces: () => ({}) as never,
    } as CompatibilityExtendedProps))

    expect(markup).toContain('dshDesktopCompatDock')
    expect(markup).toContain('dshOfficeDeskThemeHost')
    expect(markup).not.toContain('<iframe')
  })

  it('keeps the theme visible when there is no active native session', () => {
    expect(shouldRevealNativeSession(undefined)).toBe(false)
    expect(shouldRevealNativeSession('session-1' as never)).toBe(true)
  })

  it('finds the native settings trigger without depending on translated text', () => {
    const unrelatedDialog = {
      getAttribute: (name: string) => name === 'aria-haspopup' ? 'dialog' : null,
      textContent: 'Context usage 42%',
    }
    const englishTrigger = {
      getAttribute: (name: string) => name === 'aria-haspopup' ? 'dialog' : null,
      textContent: 'Settings',
    } as never
    const root = {
      querySelectorAll: () => [unrelatedDialog, englishTrigger],
    } as never
    expect(findNativeSettingsTrigger(root)).toBe(englishTrigger)
  })

  it('finds the compact settings trigger by its sidebar area', () => {
    const unrelatedDialog = {
      getAttribute: (name: string) => name === 'aria-haspopup' ? 'dialog' : null,
      textContent: '',
      closest: () => null,
    }
    const compactTrigger = {
      getAttribute: (name: string) => name === 'aria-haspopup' ? 'dialog' : null,
      textContent: '',
      closest: (selector: string) => selector.includes('settingsArea') ? {} : null,
    } as never
    const root = {
      querySelectorAll: () => [unrelatedDialog, compactTrigger],
    } as never
    expect(findNativeSettingsTrigger(root)).toBe(compactTrigger)
  })

  it('scopes theme selectors to the page that owns the content', () => {
    expect(scopedPageSelector('calendar', '.label-row span')).toBe('[data-page="calendar"] .label-row span')
    expect(scopedPageSelector('team', '.card .table tbody')).toBe('[data-page="team"] .card .table tbody')
  })

  it('binds every reader close button, including the footer action', () => {
    const buttons = [{}, {}]
    const dialog = { querySelectorAll: () => buttons } as never
    expect(closeReaderDialogButtons(dialog)).toHaveLength(2)
  })

  it('removes workspace-only font URLs and adds a tablet layout guard', () => {
    const html = officeDeskThemeHtmlForRuntime('<head><style>@font-face{src:url("/api/projects/demo/raw/font.ttf?workspaceId=x") format("truetype");}</style></head>')
    expect(html).not.toContain('/api/projects/')
    expect(html).toContain('local("Microsoft YaHei")')
    expect(html).toContain('@media (max-width:960px)')
  })
})
