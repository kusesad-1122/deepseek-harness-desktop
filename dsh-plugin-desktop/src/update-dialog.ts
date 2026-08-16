/**
 * Hermes-style update dialogs for DSH Desktop: a single styled modal window
 * (inline HTML, no preload, frameless) with three phases:
 *
 *   available   — "⚠ DSH Desktop 更新可用" banner, current → next version,
 *                 release-notes preview, buttons [立即更新][查看公告][稍后]
 *   progress    — stage line + animated progress bar + percent + 取消
 *   done        — "安装已就绪" + [立即重启安装][稍后]
 *
 * The action channel is a synthetic navigation to `https://dsh-update.local/…`
 * intercepted by `will-navigate` (no contextBridge, no preload). The window is
 * frameless with its own draggable title bar and a ✕ close button, so it does
 * not inherit the native Windows chrome. Any failure constructing or driving
 * the window falls back to the caller's native path.
 */

import { BrowserWindow } from 'electron'
import type { DesktopUpdateOffer } from './runtime.ts'

const ACTION_HOST = 'dsh-update.local'
const ACTION_PREFIX = `https://${ACTION_HOST}/action/`

export type UpdateDialogAction = 'download' | 'later' | 'notes' | 'cancel' | 'restart'

interface AvailablePayload {
  readonly current: string
  readonly next: string
  readonly releaseName: string | null
  readonly releaseNotes: string | null
  readonly releaseUrl: string | null
}

interface ProgressPayload {
  readonly version: string
  readonly stage: string
  readonly percent: number | null
}

interface DonePayload {
  readonly version: string
}

const STYLE = `  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: ui-monospace, Consolas, "Cascadia Mono", monospace; background: #14100c; color: #e8dcc8; overflow: hidden; }
  .titlebar { -webkit-app-region: drag; height: 34px; display: flex; align-items: center; padding: 0 8px; }
  .titlebar .ttl { flex: 1; font-size: 12px; color: #b8a888; padding-left: 8px; user-select: none; }
  .titlebar .close { -webkit-app-region: no-drag; background: none; border: none; color: #b8a888; font-size: 15px; line-height: 1; cursor: pointer; width: 26px; height: 26px; border-radius: 6px; padding: 0; }
  .titlebar .close:hover { color: #ff6b6b; background: rgba(255, 255, 255, 0.06); }
  .wrap { padding: 0 22px 20px; }
  .banner { font-size: 15px; font-weight: 700; color: #f5c542; margin-bottom: 6px; }
  .sub { color: #b8a888; font-size: 12px; margin-bottom: 14px; }
  .vrow { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; font-size: 14px; }
  .vold { color: #9a8a6a; text-decoration: line-through; }
  .arrow { color: #f5c542; }
  .vnew { color: #e8dcc8; font-weight: 700; }
  .notes { border-left: 3px solid #7a6a4a; padding: 2px 0 2px 10px; font-size: 12px; color: #cdbd9d; white-space: pre-wrap; max-height: 180px; overflow: auto; }
  .bar { height: 10px; background: #2a2418; border-radius: 5px; overflow: hidden; margin: 10px 0 6px; }
  .barfill { height: 100%; width: 0%; background: linear-gradient(90deg,#f5c542,#ff9f43); transition: width .18s ease; }
  .pct { font-size: 13px; color: #f5c542; text-align: right; }
  .stage { font-size: 13px; color: #cdbd9d; margin-top: 6px; }
  .btns { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
  button { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 6px; cursor: pointer; border: 1px solid #6a5c40; background: transparent; color: #e8dcc8; }
  button.primary { background: #f5c542; color: #14100c; border-color: #f5c542; font-weight: 700; }
  .err { color: #ff6b6b; font-size: 12px; margin-top: 8px; }
`

const PAGE_JS = `
  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
  window.__render = (phase, data) => { window.__phase = phase; window.__data = data; if (window.__mount) window.__mount(phase, data); };
  window.__act = (action) => { window.location = 'https://dsh-update.local/action/' + action; };
  window.__mount = (phase, data) => {
    const el = document.getElementById('root');
    if (phase === 'available') {
      const notes = (data.releaseNotes || '').slice(0, 1200);
      el.innerHTML =
        '<div class="banner">⚠ DSH Desktop 更新可用</div>' +
        '<div class="sub">' + (data.releaseName ? escapeHtml(data.releaseName) : '') + '</div>' +
        '<div class="vrow"><span class="vold">v' + escapeHtml(data.current) + '</span><span class="arrow">→</span><span class="vnew">v' + escapeHtml(data.next) + '</span></div>' +
        (notes ? '<div class="notes">' + escapeHtml(notes) + (data.releaseNotes.length > 1200 ? '\n…' : '') + '</div>' : '') +
        '<div class="btns">' +
          '<button id="b-later">稍后</button>' +
          (data.releaseUrl ? '<button id="b-notes">查看公告</button>' : '') +
          '<button id="b-dl" class="primary">立即更新</button>' +
        '</div>';
      document.getElementById('b-dl').onclick = () => window.__act('download');
      document.getElementById('b-later').onclick = () => window.__act('later');
      const bn = document.getElementById('b-notes'); if (bn) bn.onclick = () => window.__act('notes');
    } else if (phase === 'progress') {
      const pct = data.percent === null ? '' : Math.round(data.percent) + '%';
      el.innerHTML =
        '<div class="banner">⬇ 正在更新 DSH Desktop</div>' +
        '<div class="vrow"><span class="vnew">v' + escapeHtml(data.version) + '</span></div>' +
        '<div class="stage">' + escapeHtml(data.stage) + (pct ? ' … ' + pct : '') + '</div>' +
        '<div class="bar"><div id="fill" class="barfill"></div></div>' +
        '<div class="pct">' + pct + '</div>' +
        '<div class="btns"><button id="b-cancel">取消</button></div>';
      document.getElementById('b-cancel').onclick = () => window.__act('cancel');
      if (data.percent !== null) document.getElementById('fill').style.width = Math.max(0, Math.min(100, data.percent)) + '%';
    } else if (phase === 'done') {
      el.innerHTML =
        '<div class="banner">✓ 安装已就绪</div>' +
        '<div class="vrow"><span class="vnew">v' + escapeHtml(data.version) + '</span></div>' +
        '<div class="btns">' +
          '<button id="b-later2">稍后</button>' +
          '<button id="b-restart" class="primary">立即重启安装</button>' +
        '</div>';
      document.getElementById('b-restart').onclick = () => window.__act('restart');
      document.getElementById('b-later2').onclick = () => window.__act('later');
    }
  };
  window.__updateProgress = (stage, percent, version) => {
    // A progress-only window never runs ask(), so __phase is not set here.
    // First call must render the progress UI itself instead of early-returning,
    // or the window stays blank (only the dark background shows).
    if (window.__phase !== 'progress') {
      window.__render('progress', { version: version || '', stage, percent });
      return;
    }
    const data = Object.assign({}, window.__data, { stage, percent });
    window.__mount('progress', data);
  };
  document.getElementById('b-x').onclick = () => window.__act('later');
`

function pageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>DSH Desktop 更新</title>
<style>${STYLE}</style></head>
<body>
<div class="titlebar"><span class="ttl">DSH Desktop 更新</span><button class="close" id="b-x" title="关闭">✕</button></div>
<div class="wrap"><div id="root"></div></div>
<script>${PAGE_JS}</script></body></html>`
}

function renderCall(phase: string, payload: unknown): string {
  return `window.__render(${JSON.stringify(phase)}, ${JSON.stringify(payload)})`
}

/**
 * One live, styled update window. Create it, drive it through the phases, and
 * close it. Any construction error rejects so callers fall back to native UI.
 */
export class UpdateDialog {
  private readonly window: BrowserWindow
  private readonly loaded: Promise<void>
  private pending: { resolve: (action: UpdateDialogAction) => void } | undefined

  constructor(parent: BrowserWindow | undefined) {
    this.window = new BrowserWindow({
      width: 460,
      height: 380,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      // Frameless: the page draws its own draggable title bar, so the dialog
      // does not look like a native Windows window.
      frame: false,
      title: 'DSH Desktop 更新',
      backgroundColor: '#14100c',
      autoHideMenuBar: true,
      ...(parent === undefined || parent.isDestroyed() ? {} : { parent, modal: true }),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    this.window.setMenuBarVisibility(false)
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(ACTION_PREFIX)) return
      event.preventDefault()
      const action = url.slice(ACTION_PREFIX.length) as UpdateDialogAction
      if (this.pending !== undefined) {
        const resolve = this.pending.resolve
        this.pending = undefined
        resolve(action)
      } else if (action === 'later' || action === 'cancel') {
        // No question pending (progress window): closing the dialog dismisses
        // it while the background download keeps running.
        void this.window.destroy()
      }
    })
    this.window.webContents.on('did-fail-load', (_event, _code, _description) => {
      this.pending?.resolve('cancel')
      this.pending = undefined
      void this.window.destroy()
    })
    // Keep the load promise so later calls never race an in-flight data: URL
    // load with executeJavaScript (which would leave the window blank).
    this.loaded = this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml())}`)
      .catch(() => {})
  }

  /** Ask a question and wait for a single button press. */
  async ask(phase: 'available' | 'done', payload: AvailablePayload | DonePayload): Promise<UpdateDialogAction> {
    await this.ready()
    const promise = new Promise<UpdateDialogAction>((resolve) => { this.pending = { resolve } })
    await this.window.webContents.executeJavaScript(renderCall(phase, payload), true)
    this.window.setSize(phase === 'available' ? 460 : 400, phase === 'available' ? 380 : 250)
    this.window.show()
    this.window.focus()
    return promise
  }

  /** Render a live progress update (no new user interaction needed). */
  async progress(payload: ProgressPayload): Promise<void> {
    if (this.window.isDestroyed()) return
    await this.ready()
    this.window.setSize(420, 250)
    await this.window.webContents.executeJavaScript(
      `window.__updateProgress(${JSON.stringify(payload.stage)}, ${JSON.stringify(payload.percent)}, ${JSON.stringify(payload.version)})`,
      true,
    ).catch(() => {})
    this.window.show()
  }

  /** Close and destroy the window. */
  close(): void {
    this.pending?.resolve('cancel')
    this.pending = undefined
    if (!this.window.isDestroyed()) this.window.destroy()
  }

  private async ready(): Promise<void> {
    await this.loaded
  }
}

/**
 * Show the "update available" dialog. Returns the chosen action, or null when
 * the styled window could not be created (caller falls back to native UI).
 */
export async function showUpdateAvailableDialog(
  parent: BrowserWindow | undefined,
  current: string,
  next: string,
  offer: DesktopUpdateOffer,
): Promise<UpdateDialogAction | null> {
  try {
    const dialog = new UpdateDialog(parent)
    return await dialog.ask('available', {
      current,
      next,
      releaseName: offer.releaseName,
      releaseNotes: offer.releaseNotes,
      releaseUrl: offer.releaseUrl,
    }).finally(() => dialog.close())
  } catch {
    return null
  }
}
