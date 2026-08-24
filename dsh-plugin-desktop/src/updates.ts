/** Cordis Host plugin for scheduled and interactive DSH Desktop updates. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './runtime.ts'
import { startDesktopUpdateLifecycle } from './update-lifecycle.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-updates'

/** Native adapter required for network, tray, confirmation, and installer access. */
export const inject = ['desktopRuntime', 'webServer']

/** Browser-facing route that starts the same manual check as the native tray. */
export const DESKTOP_UPDATE_CHECK_ROUTE = '/dsh-desktop/updates/check'

/** Browser-facing route returning the live update lifecycle snapshot. */
export const DESKTOP_UPDATE_STATE_ROUTE = '/dsh-desktop/updates/state'

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Scheduled update policy. */
export interface Config {
  /** Enable background checks in packaged applications. */
  enabled: boolean
  /** Delay before the first background check after plugin activation. */
  initialDelayMs: number
  /** Delay between completion of one background check and the next attempt. */
  intervalMs: number
  /** Maximum duration of one version request before caller-owned cancellation. */
  requestTimeoutMs: number
}

/** Validated scheduled update policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  intervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
})

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

/** Mutating update actions must only be callable by this loopback Web app. */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function allowMethod(
  request: IncomingMessage,
  response: ServerResponse,
  method: 'GET' | 'POST',
): boolean {
  if (request.method === method) return true
  response.setHeader('allow', method)
  sendJson(response, 405, { error: `method must be ${method}` })
  return false
}

/**
 * Register effect-scoped update polling and its dynamic tray command.
 * @param ctx - Host context carrying the desktop native adapter.
 * @param config - validated polling and timeout values.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const lifecycle = startDesktopUpdateLifecycle({
      adapter: ctx.desktopRuntime.updates,
      policy: config,
      locale: () => ctx.desktopRuntime.locale,
      registerTrayItem: item => ctx.desktopRuntime.registerTrayItem(item),
    })
    const disposeCheckRoute = ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_UPDATE_CHECK_ROUTE,
      handler: async (request, response) => {
        if (!allowMethod(request, response, 'POST')) return
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'cross-origin rejected' })
          return
        }
        await lifecycle.manualCheck()
        sendJson(response, 200, { ok: true })
      },
    })
    const disposeStateRoute = ctx.webServer.register({
      kind: 'exact',
      path: DESKTOP_UPDATE_STATE_ROUTE,
      handler: (request, response) => {
        if (!allowMethod(request, response, 'GET')) return
        sendJson(response, 200, lifecycle.snapshot())
      },
    })
    return async () => {
      disposeCheckRoute()
      disposeStateRoute()
      await lifecycle.dispose()
    }
  }, 'dsh-plugin-desktop: update polling, routes, confirmation, and installer handoff')
}
