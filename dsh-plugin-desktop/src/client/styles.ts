import {
  MACOS_DRAG_REGION_HEIGHT,
  MACOS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
  WINDOWS_TITLEBAR_HEIGHT,
} from '../window-chrome.ts'
import { SIDEBAR_COLLAPSED } from './layout-state.ts'

/** Advanced-shell stylesheet kept as a plain string so the package client bundle stays self-contained. */
const ADVANCED_STYLES = `
html, body, #root { width: 100%; height: 100%; }
body[data-dsh-desktop-mode="advanced"] { margin: 0; background: transparent !important; }
.dshDesktopFrame { position: relative; display: grid; grid-template-rows: 100%; width: 100%; height: 100%; overflow: hidden; background: transparent; transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: transparent; position: relative; grid-column: 1; grid-row: 1; min-width: 0; overflow: hidden; background: transparent; border-right: 1px solid var(--dsw-alias-border-l1); }
.dshDesktopUpstreamSidebar { box-sizing: border-box; width: 100%; height: 100%; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopUpstreamSidebar { padding-top: ${MACOS_TITLEBAR_HEIGHT}px; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"][data-sidebar-collapsed] .dshDesktopUpstreamSidebar { width: ${SIDEBAR_COLLAPSED}px; margin: 0 auto; }
.dshDesktopFrame[data-desktop-platform="darwin"] { grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface { grid-row: 1 / -1; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopDetailsSurface { grid-row: 2; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface::before { content: ""; position: absolute; top: 0; right: 0; left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopMacCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopMacCaptionRow::before { content: ""; position: absolute; top: 0; right: 0; left: 0; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopConversationSurface { grid-column: 2; grid-row: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base); }
.dshDesktopDetailsSurface { grid-column: 3; grid-row: 1; min-width: 0; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopFrame[data-details-collapsed] .dshDesktopDetailsSurface { border-left: none; }
.dshDesktopFrame[data-desktop-platform="win32"] { grid-template-rows: ${WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopSidebarSurface { grid-row: 1 / -1; }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopDetailsSurface { grid-row: 2; }
.dshDesktopWindowsCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopWindowsCaptionRow::before { content: ""; position: absolute; inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0; user-select: none; -webkit-app-region: drag; }
.dshDesktopFrame[data-dragging] { transition: none; }
.dshDesktopOverlay { position: absolute; z-index: 1000; inset: 0; pointer-events: none; }
.dshDesktopOverlay > * { pointer-events: auto; }
.dshDesktopResizeHandle { position: absolute; z-index: 50; top: 0; bottom: 0; width: 8px; margin-left: -4px; cursor: col-resize; touch-action: none; -webkit-app-region: no-drag; transition: left var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopFrame[data-dragging] .dshDesktopResizeHandle { transition: none; }
.dshDesktopNoDrag, button, input, textarea, select, a, [role="button"], [role="dialog"], [role="presentation"] { -webkit-app-region: no-drag; }
[role="dialog"], [aria-modal="true"] { -webkit-app-region: no-drag !important; }
html:has([aria-modal="true"]) .dshDesktopWindowsCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopMacCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface::before { -webkit-app-region: no-drag !important; }
@media (prefers-reduced-motion: reduce) {
  .dshDesktopFrame,
  .dshDesktopResizeHandle { transition: none !important; }
}
`

/** Install and remove the advanced shell's global native-window styles. @returns the style disposer. */
export function installAdvancedStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/advanced-shell'
  style.textContent = ADVANCED_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

/**
 * Compatibility-shell stylesheet for the left extended dock. The dock is a
 * viewport-anchored fixed column registered into the upstream `shell.overlay`
 * layer; the app is pushed right by the dock width through a `#root`
 * margin-left owned by the dock effect (fixed children ignore ancestor
 * margins, so the dock never moves with the app).
 */
const COMPATIBILITY_STYLES = `
.dshDesktopCompatDock {
  position: fixed; left: 0; top: 0; bottom: 0; z-index: 1000;
  display: flex; flex-direction: column; overflow: hidden;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  border-right: 1px solid var(--dsw-alias-border-l1);
}
body[data-dsh-desktop-mode="compatibility"] #root {
  margin-left: var(--dsh-compat-root-offset, 0px);
  transition: margin-left var(--ds-transition-duration-slow, 180ms) ease;
}
@media (prefers-reduced-motion: reduce) { body[data-dsh-desktop-mode="compatibility"] #root { transition: none !important; } }

/* ── boujoy-fused workspace：现代办公主题（Codex gpt-5.6-terra 设计规范） ── */
.bjyWorkspace {
  --bjy-bg-page: #f5f7fb;
  --bjy-bg-nav: #ffffff;
  --bjy-bg-card: #ffffff;
  --bjy-bg-card-subtle: #f8fafc;
  --bjy-bg-input: #ffffff;
  --bjy-bg-hover: #f1f5f9;
  --bjy-primary: #2563eb;
  --bjy-primary-hover: #1d4ed8;
  --bjy-primary-soft: #eff6ff;
  --bjy-primary-border: #bfdbfe;
  --bjy-secondary: #0f766e;
  --bjy-success: #16a34a;
  --bjy-warning: #d97706;
  --bjy-danger: #dc2626;
  --bjy-text-main: #111827;
  --bjy-text-secondary: #475569;
  --bjy-text-muted: #64748b;
  --bjy-text-faint: #94a3b8;
  --bjy-border: #e2e8f0;
  --bjy-border-strong: #cbd5e1;
  --bjy-radius-md: 10px;
  --bjy-radius-lg: 12px;
  --bjy-shadow-sm: 0 4px 12px rgba(15, 23, 42, 0.06);
  --bjy-shadow-md: 0 10px 28px rgba(15, 23, 42, 0.08);
  --bjy-ease: cubic-bezier(0.2, 0, 0, 1);
  background: var(--bjy-bg-page);
  color: var(--bjy-text-main);
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
    "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.bjyWorkspace button {
  color: var(--bjy-text-secondary);
  border-color: var(--bjy-border);
  background: var(--bjy-bg-card);
  transition: background 120ms var(--bjy-ease), border-color 120ms var(--bjy-ease), color 120ms var(--bjy-ease);
}
.bjyWorkspace button:hover:not(:disabled) {
  background: var(--bjy-bg-hover);
  border-color: var(--bjy-border-strong);
  color: var(--bjy-text-main);
  transform: none;
  box-shadow: none;
}
.bjyWorkspace input, .bjyWorkspace textarea {
  background: var(--bjy-bg-input);
  color: var(--bjy-text-main);
  border-color: var(--bjy-border-strong);
  caret-color: var(--bjy-primary);
}
.bjyWorkspace input::placeholder, .bjyWorkspace textarea::placeholder { color: var(--bjy-text-faint); }
.bjyWorkspace input:focus, .bjyWorkspace textarea:focus {
  outline: none;
  border-color: var(--bjy-primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.16);
}
.bjyWorkspace a { color: var(--bjy-secondary); }
.bjyWorkspace h1, .bjyWorkspace h2, .bjyWorkspace h3 { color: var(--bjy-text-main); }
.bjyNav {
  background: var(--bjy-bg-nav);
  border-right: 1px solid var(--bjy-border);
  box-shadow: 1px 0 0 rgba(15, 23, 42, 0.02);
}
.bjyNav button { color: var(--bjy-text-secondary); background: transparent; border-color: transparent; }
.bjyNav button:hover { background: var(--bjy-bg-hover); color: var(--bjy-text-main); }
.bjyNavActive {
  position: relative;
  color: var(--bjy-primary-hover) !important;
  background: var(--bjy-primary-soft) !important;
  border-color: var(--bjy-primary-border) !important;
  box-shadow: inset 3px 0 0 var(--bjy-primary);
  font-weight: 700;
}
.bjyNavActive svg, .bjyNavActive span { color: var(--bjy-primary-hover) !important; }
.bjyRailActive {
  color: var(--bjy-primary-hover) !important;
  border-color: var(--bjy-primary-border) !important;
  background: var(--bjy-primary-soft) !important;
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.06);
}
.bjyPrimary {
  min-height: 32px;
  color: #ffffff !important;
  background: var(--bjy-primary) !important;
  border-color: var(--bjy-primary) !important;
  font-family: inherit;
  font-weight: 700;
  box-shadow: 0 1px 2px rgba(37, 99, 235, 0.18);
  transition: background 120ms var(--bjy-ease), box-shadow 120ms var(--bjy-ease), transform 120ms var(--bjy-ease);
}
.bjyPrimary:hover:not(:disabled) {
  background: var(--bjy-primary-hover) !important;
  border-color: var(--bjy-primary-hover) !important;
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.18);
  transform: translateY(-1px);
}
.bjyPrimary:disabled { opacity: 0.55; cursor: not-allowed; box-shadow: none; }
.bjyPageTitle {
  font-family: inherit;
  font-weight: 700; letter-spacing: 0.01em; color: var(--bjy-text-main);
}
.bjyHero::before {
  content: "";
  display: inline-block; width: 10px; height: 10px; margin-right: 8px;
  background: var(--bjy-primary); border-radius: 3px;
}
.bjyCard {
  background: var(--bjy-bg-card);
  border-color: var(--bjy-border) !important;
  color: var(--bjy-text-main);
  transition: transform 160ms var(--bjy-ease), box-shadow 160ms var(--bjy-ease), border-color 160ms var(--bjy-ease);
}
.bjyCard:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.07);
  border-color: var(--bjy-border-strong) !important;
}
.bjyMuted { color: var(--bjy-text-muted) !important; }
.bjyPageBody { background: transparent; }
.bjyPageBody > div { animation: bjyPageIn 140ms var(--bjy-ease); }
.bjyNewsThumb {
  position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden;
  background: var(--bjy-bg-hover);
  border: 1px solid var(--bjy-border);
}
.bjyNewsThumb img { width: 100%; height: 100%; object-fit: cover; display: block; filter: saturate(0.92) contrast(1.02); transition: transform 180ms ease; }
.bjyNewsThumb:hover img { transform: scale(1.025); }
.bjyNewsThumbMark {
  position: absolute; left: 8px; top: 8px; padding: 3px 7px;
  color: #ffffff; background: rgba(15, 23, 42, 0.72); backdrop-filter: blur(8px);
  font: 700 9px ui-monospace, Consolas, monospace; letter-spacing: 0.06em;
  border-radius: 6px;
}
.bjyChip { background: var(--bjy-bg-hover); color: var(--bjy-text-secondary); }
@keyframes bjyPageIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .bjyWorkspace *, .bjyWorkspace *::before, .bjyWorkspace *::after {
    animation: none !important;
    transition: none !important;
  }
}
`

/** Install and remove the compatibility shell's left-dock styles. @returns the style disposer. */
export function installCompatibilityStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/compatibility-shell'
  style.textContent = COMPATIBILITY_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
