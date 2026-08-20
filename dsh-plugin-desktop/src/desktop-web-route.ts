/** Same-origin loopback routing for desktop agent-side bridge plugins. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

interface LocationLike {
  readonly origin?: string
}

export interface DesktopWebRouteClient {
  readonly origin: string
  url(route: string): string
  mutationHeaders(headers: Record<string, string>): Record<string, string>
}

/** Bind a desktop bridge to the active loopback Web server. */
export function desktopWebRouteClient(ctx: Context): DesktopWebRouteClient {
  return desktopWebRouteClientForOrigin(`http://127.0.0.1:${String(ctx.webServer.port)}`)
}

/** Create a route client from one concrete server origin. */
export function desktopWebRouteClientForOrigin(
  serverOrigin: string,
  location: LocationLike | undefined = (globalThis as { location?: LocationLike }).location,
): DesktopWebRouteClient {
  const server = new URL(serverOrigin)
  if (server.protocol !== 'http:' || server.hostname !== '127.0.0.1' || server.port === '') {
    throw new Error('dsh-plugin-desktop: desktop bridge requires a loopback HTTP origin')
  }
  const browserOrigin = location?.origin
  const isBrowser = browserOrigin !== undefined && browserOrigin !== 'null'
  const origin = isBrowser ? new URL(browserOrigin).origin : server.origin
  return {
    origin,
    url: route => new URL(route, origin).href,
    mutationHeaders: headers => isBrowser ? headers : { ...headers, origin: server.origin },
  }
}
