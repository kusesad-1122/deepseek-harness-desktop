/** Electron implementation of the launcher-provided desktop runtime capability. */

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  shell,
  Tray,
} from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopTerminalStateDirectory, openDesktopTerminal } from './desktop-terminal.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import type {
  DesktopNotification,
  DesktopPlatform,
  DesktopRuntime,
  DesktopShellSpec,
  DesktopTerminalSpec,
  DesktopThemeSource,
  DesktopTrayItem,
  DesktopTrayItemGroup,
  DesktopTrayItemRegistration,
  DesktopUpdateAdapter,
  DesktopUpdateOffer,
  DesktopUpdateProgressHandler,
} from './runtime.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import { downloadDesktopUpdate } from './update-download.ts'
import { showUpdateAvailableDialog, UpdateDialog } from './update-dialog.ts'
import type { UpdateCheckResult } from './update-checker.ts'
import { desktopWindowOptions } from './window-options.ts'

/** Return the presentation mode opposite the active generation. */
export function nextDesktopShellMode(mode: DesktopShellSpec['mode']): DesktopShellSpec['mode'] {
  return mode === 'compatibility' ? 'advanced' : 'compatibility'
}

/** Return the tray command describing the mode that will be activated. */
export function modeToggleLabel(mode: DesktopShellSpec['mode']): string {
  return mode === 'compatibility'
    ? 'Switch to Advanced Mode'
    : 'Switch to Compatibility Mode'
}

/**
 * Read the desktop package version instead of Electron's development-app version.
 * @param moduleUrl - module below the package's `src` or `lib` directory.
 * @returns validated desktop product version.
 */
export function desktopProductVersion(moduleUrl: string = import.meta.url): string {
  const value: unknown = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8'))
  if (value === null || typeof value !== 'object' || typeof (value as { version?: unknown }).version !== 'string') {
    throw new Error('dsh-plugin-desktop: package.json has no product version')
  }
  return (value as { version: string }).version
}

const PRODUCT_VERSION = desktopProductVersion()

/** How long the Windows installer hand-off is observed before the app quits. */
const UPDATE_HANDOFF_SETTLE_MS = 1500

/** Native adapter used by the DSH Desktop launcher and owned by its Cordis shell plugin. */
export class ElectronDesktopRuntime implements DesktopRuntime {
  readonly platform: DesktopPlatform
  readonly updates: DesktopUpdateAdapter = {
    get isPackaged() { return app.isPackaged },
    get canDownload() { return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32') },
    get currentVersion() { return PRODUCT_VERSION },
    get statePath() { return join(app.getPath('userData'), 'updates', 'state.json') },
    request: (url, init) => net.fetch(url, init),
    confirmDownload: version => this.confirmUpdateDownload(version),
    showManualCheckResult: result => this.showManualUpdateCheckResult(result),
    downloadAndOpen: (version, signal, url) => this.downloadAndOpenUpdate(version, signal, url),
    notify: notification => { this.showNotification(notification) },
  }

  private window: BrowserWindow | undefined
  private tray: Tray | undefined
  private scheduled: DesktopShellSpec | undefined
  private mountTask: Promise<void> | undefined
  private release: (() => Promise<void>) | undefined
  private quitting = false
  private readonly trayItems = new Map<symbol, DesktopTrayItem>()
  private terminalSpec: DesktopTerminalSpec | undefined

  constructor(private readonly restart: () => Promise<void>) {
    if (process.platform !== 'darwin' && process.platform !== 'win32' && process.platform !== 'linux') {
      throw new Error(`dsh-plugin-desktop: unsupported Electron platform ${process.platform}`)
    }
    this.platform = process.platform
  }

  /** @inheritdoc */
  schedule(spec: DesktopShellSpec): () => Promise<void> {
    if (this.scheduled !== undefined || this.mountTask !== undefined) {
      throw new Error('dsh-plugin-desktop: a native shell generation is already registered')
    }
    const previousThemeSource = nativeTheme.themeSource
    this.scheduled = spec
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      try {
        await this.mountTask
      } finally {
        try {
          await this.release?.()
        } finally {
          this.release = undefined
          this.mountTask = undefined
          if (this.scheduled === spec) {
            if (spec.mode === 'advanced') nativeTheme.themeSource = previousThemeSource
            this.scheduled = undefined
          }
        }
      }
    }
  }

  /** @inheritdoc */
  mountScheduled(beforeInteractive?: () => void): Promise<void> {
    const spec = this.scheduled
    if (spec === undefined) {
      return Promise.reject(new Error('dsh-plugin-desktop: the Cordis shell plugin did not register a window'))
    }
    this.mountTask ??= this.mount(spec, beforeInteractive).then((release) => { this.release = release })
    return this.mountTask
  }

  /** @inheritdoc */
  show(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  /** @inheritdoc */
  registerTrayItem(item: DesktopTrayItem): DesktopTrayItemRegistration {
    const key = Symbol()
    this.trayItems.set(key, item)
    this.rebuildTrayMenu()
    let active = true
    return {
      refresh: () => {
        if (active) this.rebuildTrayMenu()
      },
      dispose: () => {
        if (!active) return
        active = false
        this.trayItems.delete(key)
        this.rebuildTrayMenu()
      },
    }
  }

  /**
   * Fix the profile identity before Cordis plugins can contribute terminal commands.
   * @param spec - launcher-resolved desktop profile and Harness home.
   */
  configureTerminal(spec: DesktopTerminalSpec): void {
    if (this.terminalSpec !== undefined) {
      throw new Error('dsh-plugin-desktop: terminal profile is already configured')
    }
    this.terminalSpec = { ...spec }
  }

  /** @inheritdoc */
  openTerminal(): void {
    try {
      const spec = this.terminalSpec
      if (spec === undefined) {
        throw new Error('dsh-plugin-desktop: terminal profile is not configured')
      }
      const electronVersion = process.versions.electron
      if (electronVersion === undefined) {
        throw new Error('dsh-plugin-desktop: terminal requires the Electron runtime version')
      }
      openDesktopTerminal({
        platform: this.platform,
        appExecutable: process.execPath,
        dshBootstrapPath: fileURLToPath(new URL('./desktop-cli.js', import.meta.url)),
        pnpmBinPath: packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs'),
        electronVersion,
        profileName: spec.profileName,
        productVersion: PRODUCT_VERSION,
        profileDir: spec.profileDir,
        homeDir: spec.homeDir,
        stateDir: desktopTerminalStateDirectory(app.getPath('userData'), spec.profileName),
        spawn,
        onLaunchError: cause => { this.reportTerminalLaunchError(cause) },
      })
    } catch (cause) {
      this.reportTerminalLaunchError(cause)
    }
  }

  /** @inheritdoc */
  setThemeSource(source: DesktopThemeSource): void {
    if (this.scheduled?.mode === 'advanced' && this.window !== undefined) {
      nativeTheme.themeSource = source
    }
  }

  /** @inheritdoc */
  async requestRestart(): Promise<void> {
    await this.restart()
  }

  /** @inheritdoc */
  prepareToQuit(): void {
    this.quitting = true
  }

  private contributedTrayItems(group: DesktopTrayItemGroup): Electron.MenuItemConstructorOptions[] {
    return [...this.trayItems.values()]
      .filter(item => item.group === group)
      .sort((left, right) => left.order - right.order)
      .map((item): Electron.MenuItemConstructorOptions => {
        const common = {
          label: item.label(),
          enabled: item.enabled?.() ?? true,
        }
        if (item.submenu !== undefined) {
          return {
            ...common,
            submenu: item.submenu().map(command => ({
              label: command.label(),
              enabled: command.enabled?.() ?? true,
              ...(command.type === undefined ? {} : { type: command.type }),
              ...(command.checked === undefined ? {} : { checked: command.checked() }),
              click: this.trayCommand(() => command.invoke()),
            })),
          }
        }
        return {
          ...common,
          click: this.trayCommand(() => item.invoke()),
        }
      })
  }

  /** Contain asynchronous contribution failures outside Electron menu callbacks. */
  private trayCommand(invoke: () => void | Promise<void>): () => void {
    return () => {
      void Promise.resolve().then(invoke).catch((cause: unknown) => {
        process.stderr.write(`dsh-plugin-desktop: tray command failed: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      })
    }
  }

  private showNotification(notification: DesktopNotification): void {
    if (!Notification.isSupported()) return
    const nativeNotification = new Notification({
      title: notification.title,
      body: notification.body,
    })
    nativeNotification.show()
  }

  /** Ask before making the fixed download endpoint's counted request. */
  private async confirmUpdateDownload(version: string, offer?: DesktopUpdateOffer): Promise<boolean> {
    const fallback = offer ?? { releaseUrl: null, releaseName: null, releaseNotes: null, publishedAt: null }

    // Hermes-style styled banner dialog; fall back to the native message box
    // when the custom window cannot be constructed.
    const action = await showUpdateAvailableDialog(this.window, PRODUCT_VERSION, version, fallback)
    if (action === 'download') return true
    if (action === 'notes' && fallback.releaseUrl !== null) {
      try {
        await shell.openExternal(fallback.releaseUrl)
      } catch {
        // Opening the announcement page is best-effort; the user can still download next time.
      }
    }
    if (action !== null) return false

    const releaseUrl = fallback.releaseUrl
    const buttons = releaseUrl === null ? ['Download', 'Later'] : ['Download', 'Release Notes', 'Later']
    const defaultId = releaseUrl === null ? 1 : 2
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'DSH Desktop Update Available',
      message: `DSH Desktop ${version} is available.`,
      detail: fallback.releaseNotes ?? 'Download this update now?',
      buttons,
      defaultId,
      cancelId: defaultId,
      noLink: true,
    })
    if (result.response === 0) return true
    if (releaseUrl !== null && result.response === 1) {
      try {
        await shell.openExternal(releaseUrl)
      } catch {
        // Opening the announcement page is best-effort; the user can still download next time.
      }
    }
    return false
  }

  /** Report one user-triggered check without exposing network or response details. */
  private async showManualUpdateCheckResult(result: UpdateCheckResult | null): Promise<void> {
    if (result === null) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Unable to Check for Updates',
        message: 'DSH Desktop could not check for updates.',
        detail: 'Please try again later.',
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    if (result.status === 'up-to-date') {
      await dialog.showMessageBox({
        type: 'info',
        title: 'DSH Desktop Is Up to Date',
        message: 'No newer version of DSH Desktop is available.',
        detail: `Installed version: ${result.currentVersion}`,
        buttons: ['OK'],
        defaultId: 0,
        noLink: true,
      })
      return
    }

    await dialog.showMessageBox({
      type: 'info',
      title: 'DSH Desktop Update Available',
      message: `DSH Desktop ${result.latestVersion} is available.`,
      detail: 'Installer downloads are unavailable in this build.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    })
  }

  /** Download a confirmed installer and hand it to the native installation flow. */
  private async downloadAndOpenUpdate(
    version: string,
    signal: AbortSignal,
    url?: string,
    onProgress?: DesktopUpdateProgressHandler,
  ): Promise<void> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') {
      throw new Error(`dsh-plugin-desktop: updates are unavailable on ${this.platform}`)
    }

    // Styled Hermes-style progress window; best-effort (falls back to tray-only).
    let updateDialog: UpdateDialog | undefined
    try {
      updateDialog = new UpdateDialog(this.window)
      await updateDialog.progress({ version, stage: '下载中', percent: 0 })
    } catch {
      updateDialog = undefined
    }
    const progressOf = (received: number, total: number | null): number | null =>
      total === null || total <= 0 ? null : Math.max(0, Math.min(100, Math.round((received / total) * 100)))

    try {
      const artifactPath = await downloadDesktopUpdate({
        platform: this.platform,
        version,
        userDataPath: app.getPath('userData'),
        request: (requestUrl, init) => net.fetch(requestUrl, init),
        signal,
        ...(url === undefined ? {} : { url }),
        onProgress: (received, total) => {
          if (onProgress !== undefined) onProgress(received, total)
          if (updateDialog !== undefined) {
            void updateDialog.progress({ version, stage: '下载中', percent: progressOf(received, total) }).catch(() => {})
          }
        },
      })
      signal.throwIfAborted()

      if (this.platform === 'darwin') {
        const openError = await shell.openPath(artifactPath)
        if (openError !== '') throw new Error(`dsh-plugin-desktop: failed to open update disk image: ${openError}`)
        signal.throwIfAborted()
        if (updateDialog !== undefined) {
          await updateDialog.progress({ version, stage: '校验中', percent: 100 }).catch(() => {})
        }
        await updateDialog?.ask('done', { version }).catch(() => {})
        await updateDialog?.close()
        await dialog.showMessageBox({
          type: 'info',
          title: 'DSH Desktop Update Downloaded',
          message: `DSH Desktop ${version} is ready to install.`,
          detail: 'The disk image has opened. Replace DSH Desktop in Applications, then reopen it.',
          buttons: ['OK'],
          defaultId: 0,
          noLink: true,
        })
        return
      }

      // Windows: styled "restart and install" prompt with native fallback.
      let restart = false
      if (updateDialog !== undefined) {
        try {
          await updateDialog.progress({ version, stage: '校验中', percent: 100 })
          restart = (await updateDialog.ask('done', { version })) === 'restart'
        } catch {
          restart = false
        }
      }
      if (!restart) {
        const result = await dialog.showMessageBox({
          type: 'info',
          title: 'DSH Desktop Update Downloaded',
          message: `DSH Desktop ${version} is ready to install.`,
          detail: 'Restart DSH Desktop and run the installer now?',
          buttons: ['Restart and Install', 'Later'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        if (result.response !== 0) return
      }

      const spec = this.scheduled
      if (spec === undefined) throw new Error('dsh-plugin-desktop: no active shell can exit for update installation')
      signal.throwIfAborted()
      await this.launchWindowsUpdateInstaller(artifactPath)
      this.quitting = true
      spec.requestQuit(0)
    } finally {
      updateDialog?.close()
    }
  }

  /** Start the downloaded NSIS installer before releasing the current process. */
  private async launchWindowsUpdateInstaller(installerPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(installerPath, ['--updated', '--force-run'], {
          detached: true,
          stdio: 'ignore',
          shell: false,
          windowsHide: false,
        })
      } catch (cause) {
        reject(cause)
        return
      }

      // Verify the detached hand-off actually became viable before this app
      // quits. A silent spawn failure (ENOENT/EACCES reported asynchronously)
      // would otherwise look identical to success: the window closes and no
      // installer ever appears. Success means no `error` and either the child
      // survives the settle window or exits 0 inside it.
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.unref()
        resolve()
      }, UPDATE_HANDOFF_SETTLE_MS)
      const settle = (): void => { clearTimeout(timer) }
      child.once('error', (cause: Error) => {
        if (settled) return
        settled = true
        settle()
        reject(new Error(`dsh-plugin-desktop: update installer failed to start: ${cause.message}`))
      })
      child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        settle()
        if (signal !== null || (typeof code === 'number' && code !== 0)) {
          reject(new Error(
            signal !== null
              ? `dsh-plugin-desktop: update installer died from signal ${String(signal)} before the settle window elapsed`
              : `dsh-plugin-desktop: update installer exited ${String(code)} before the settle window elapsed`,
          ))
          return
        }
        resolve()
      })
    })
  }

  /** Keep native-terminal launch failures visible in a packaged GUI process. */
  private reportTerminalLaunchError(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    process.stderr.write(`dsh-plugin-desktop: failed to open terminal: ${error.message}\n`)
    try {
      dialog.showErrorBox('Unable to Open DSH Terminal', error.message)
    } catch (dialogCause) {
      process.stderr.write(`dsh-plugin-desktop: failed to show terminal error: ${dialogCause instanceof Error ? dialogCause.message : String(dialogCause)}\n`)
    }
  }

  private rebuildTrayMenu(): void {
    const tray = this.tray
    const spec = this.scheduled
    if (tray === undefined || spec === undefined) return

    const show = (): void => { this.show() }
    const tools = this.contributedTrayItems('tools')
    const profiles = this.contributedTrayItems('profiles')
    const status = this.contributedTrayItems('status')
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: `Open ${spec.productName}`, click: show },
    ]
    if (tools.length > 0) template.push({ type: 'separator' }, ...tools)
    if (profiles.length > 0) template.push({ type: 'separator' }, ...profiles)
    if (status.length > 0) template.push({ type: 'separator' }, ...status)
    template.push(
      { type: 'separator' },
      {
        label: modeToggleLabel(spec.mode),
        enabled: this.platform !== 'linux',
        click: () => {
          void spec.requestModeChange(nextDesktopShellMode(spec.mode)).catch((cause: unknown) => {
            process.stderr.write(`dsh-plugin-desktop: failed to change shell mode: ${cause instanceof Error ? cause.message : String(cause)}\n`)
          })
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { spec.requestQuit(0) } },
    )
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  private async mount(
    spec: DesktopShellSpec,
    beforeInteractive: (() => void) | undefined,
  ): Promise<() => Promise<void>> {
    const icon = nativeImage.createFromPath(spec.iconPath)
    if (icon.isEmpty()) {
      throw new Error(`dsh-plugin-desktop: failed to load application icon ${spec.iconPath}`)
    }
    if (this.platform === 'darwin') app.dock?.setIcon(icon)
    const origin = new URL(spec.url).origin
    if (spec.mode === 'advanced') nativeTheme.themeSource = spec.readThemeSource()
    const window = new BrowserWindow(desktopWindowOptions(spec, icon, this.platform))
    window.accessibleTitle = spec.windowTitle
    if (this.platform === 'win32') window.removeMenu()
    this.window = window

    const show = (): void => { this.show() }
    const close = (event: Electron.Event): void => {
      if (this.quitting) return
      event.preventDefault()
      window.hide()
    }
    const preserveBlankTitle = (event: Electron.Event): void => { event.preventDefault() }
    const navigate = (event: Electron.Event<{ url: string }>): void => {
      let targetOrigin: string | undefined
      try {
        targetOrigin = new URL(event.url).origin
      } catch {
        targetOrigin = undefined
      }
      if (targetOrigin !== origin) event.preventDefault()
    }

    app.on('activate', show)
    window.on('close', close)
    window.on('page-title-updated', preserveBlankTitle)
    window.webContents.on('will-frame-navigate', navigate)
    window.webContents.on('will-redirect', navigate)
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url)
        if (target.protocol === 'https:' || target.protocol === 'http:' || target.protocol === 'mailto:') {
          void shell.openExternal(target.href).catch((cause: unknown) => {
            process.stderr.write(`dsh-plugin-desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}\n`)
          })
        }
      } catch {
        // A malformed target is rejected with the same deny result.
      }
      return { action: 'deny' }
    })

    window.once('ready-to-show', show)
    let tray: Tray | undefined
    try {
      await window.loadURL(spec.url)
      tray = new Tray(prepareTrayIcon(spec.trayIcons, this.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.rebuildTrayMenu()
      tray.on('click', show)
      beforeInteractive?.()
    } catch (cause) {
      app.off('activate', show)
      window.off('page-title-updated', preserveBlankTitle)
      tray?.off('click', show)
      tray?.destroy()
      window.destroy()
      this.tray = undefined
      this.window = undefined
      throw cause
    }

    if (tray === undefined) {
      throw new Error('dsh-plugin-desktop: native tray did not mount')
    }
    const mountedTray = tray

    let released = false
    return async () => {
      if (released) return
      released = true
      app.off('activate', show)
      window.off('close', close)
      window.off('page-title-updated', preserveBlankTitle)
      window.webContents.off('will-frame-navigate', navigate)
      window.webContents.off('will-redirect', navigate)
      mountedTray.off('click', show)
      mountedTray.destroy()
      if (!window.isDestroyed()) window.destroy()
      if (this.tray === mountedTray) this.tray = undefined
      if (this.window === window) this.window = undefined
    }
  }
}
