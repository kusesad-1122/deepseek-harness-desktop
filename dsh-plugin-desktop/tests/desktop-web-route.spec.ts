import { describe, expect, it } from 'vitest'
import { desktopWebRouteClientForOrigin } from '../src/desktop-web-route.ts'

describe('desktopWebRouteClientForOrigin', () => {
  it('makes Node bridge requests absolute and same-origin', () => {
    const client = desktopWebRouteClientForOrigin('http://127.0.0.1:52280')
    expect(client.url('/dsh-desktop/memory/write')).toBe('http://127.0.0.1:52280/dsh-desktop/memory/write')
    expect(client.mutationHeaders({ 'content-type': 'application/json' })).toEqual({
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:52280',
    })
  })

  it('uses a browser origin without manually setting Origin', () => {
    const client = desktopWebRouteClientForOrigin('http://127.0.0.1:52280', { origin: 'http://127.0.0.1:52280' })
    expect(client.url('/dsh-desktop/knowledge/cards')).toBe('http://127.0.0.1:52280/dsh-desktop/knowledge/cards')
    expect(client.mutationHeaders({ 'content-type': 'application/json' })).toEqual({ 'content-type': 'application/json' })
  })

  it('rejects a non-loopback bridge origin', () => {
    expect(() => desktopWebRouteClientForOrigin('https://example.test')).toThrow('requires a loopback HTTP origin')
  })
})
