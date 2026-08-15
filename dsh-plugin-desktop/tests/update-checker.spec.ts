import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_VERSION_ENDPOINT,
  MAX_RELEASE_NOTES_CHARS,
  MAX_RELEASE_RESPONSE_BYTES,
  MAX_VERSION_RESPONSE_BYTES,
  checkForGithubReleaseUpdate,
  checkForStableUpdate,
  compareSemVerVersions,
  githubReleaseEndpoint,
  parseSemVer,
  truncateReleaseNotes,
  type UpdateRequest,
} from '../src/update-checker.ts'

function versionResponse(version: unknown, init: ResponseInit = {}): Response {
  return Response.json({ version }, init)
}

describe('strict SemVer parsing', () => {
  it('accepts a three-part version, optional lowercase v, prerelease, and build metadata', () => {
    expect(parseSemVer('v2.10.3-alpha.1+mac.arm64')).toEqual({
      version: '2.10.3-alpha.1+mac.arm64',
      major: '2',
      minor: '10',
      patch: '3',
      prerelease: ['alpha', '1'],
      build: ['mac', 'arm64'],
    })
    expect(parseSemVer('0.0.0')).not.toBeNull()
  })

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+',
    'V1.2.3',
    ' 1.2.3',
  ])('rejects invalid SemVer %s', version => {
    expect(parseSemVer(version)).toBeNull()
  })

  it('compares strict versions without numeric overflow', () => {
    expect(compareSemVerVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemVerVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemVerVersions('2.0', '2.0.0')).toBeNull()
    expect(compareSemVerVersions(
      '10000000000000000.0.0',
      '9007199254740992.0.0',
    )).toBeGreaterThan(0)
  })
})

describe('public Desktop version check', () => {
  it('uses only the fixed no-cache version endpoint and reports a newer stable version', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return versionResponse('2.10.0')
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_VERSION_ENDPOINT)
    expect(calls[0]?.url).not.toContain('/api/downloads/')
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.has('if-none-match')).toBe(false)
    expect(headers.has('x-github-api-version')).toBe(false)
  })

  it.each([
    ['2.0.0', '2.0.0'],
    ['2.0.1', '2.0.0'],
    ['2.0.0+installed', '2.0.0+release'],
  ])('reports no update for installed %s and service %s', async (currentVersion, latestVersion) => {
    await expect(checkForStableUpdate({
      currentVersion,
      request: async () => versionResponse(latestVersion),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion,
    })
  })

  it('compares service versions without overflowing JavaScript numbers', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '9007199254740992.0.0',
      request: async () => versionResponse('10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
  })

  it.each([
    ['leading v', { version: 'v2.1.0' }],
    ['prerelease', { version: '2.1.0-rc.1' }],
    ['invalid SemVer', { version: '2.01.0' }],
    ['missing version', {}],
    ['non-string version', { version: 2 }],
    ['array response', ['2.1.0']],
  ])('silently ignores a service response with %s', async (_case, value) => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json(value),
    })).resolves.toBeNull()
  })

  it('silently ignores malformed JSON and non-200 statuses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('unavailable', { status: 503 }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toBeNull()
  })

  it('silently ignores network failure and caller cancellation', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => { throw new TypeError('offline') },
    })).resolves.toBeNull()

    const controller = new AbortController()
    controller.abort()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      signal: controller.signal,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    })).resolves.toBeNull()
  })

  it('silently ignores declared and streamed oversized responses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_VERSION_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_VERSION_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each(['2.0', 'v2.0.0', '2.0.0-rc.1'])('skips invalid installed version %s before requesting', async currentVersion => {
    const request = vi.fn(async () => versionResponse('2.1.0'))

    await expect(checkForStableUpdate({ currentVersion, request })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('GitHub Releases version check', () => {
  function releaseResponse(tagName: unknown, assets: unknown = []): Response {
    return Response.json({ tag_name: tagName, assets })
  }

  it('follows the latest-release redirect, accepts a v-prefixed tag, and selects the Windows asset', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return releaseResponse('v2.10.0', [{
        name: 'DSH-Desktop-2.10.0-x64-Setup.exe',
        browser_download_url: 'https://example.test/DSH-Desktop-2.10.0-x64-Setup.exe',
      }])
    }

    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.9.9',
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
      assetUrl: 'https://example.test/DSH-Desktop-2.10.0-x64-Setup.exe',
      releaseUrl: null,
      releaseName: null,
      releaseNotes: null,
      publishedAt: null,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(githubReleaseEndpoint('kusesad-1122', 'deepseek-harness-desktop'))
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(headers.has('x-github-api-version')).toBe(false)
  })

  it('surfaces the release page, announcement, and publication timestamp', async () => {
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.9.9',
      request: async () => Response.json({
        tag_name: 'v2.10.0',
        assets: [],
        html_url: 'https://github.com/kusesad-1122/deepseek-harness-desktop/releases/tag/v2.10.0',
        name: 'v2.10.0 更新公告',
        body: '# 更新公告\r\n- 新功能一\r\n- 修复二\r\n',
        published_at: '2026-08-16T00:00:00Z',
      }),
    })).resolves.toMatchObject({
      status: 'update-available',
      latestVersion: '2.10.0',
      assetUrl: null,
      releaseUrl: 'https://github.com/kusesad-1122/deepseek-harness-desktop/releases/tag/v2.10.0',
      releaseName: 'v2.10.0 更新公告',
      releaseNotes: '# 更新公告\n- 新功能一\n- 修复二',
      publishedAt: '2026-08-16T00:00:00Z',
    })
  })

  it('normalizes and caps release announcements for native dialogs', () => {
    expect(truncateReleaseNotes('   \r\n  ')).toBeNull()
    expect(truncateReleaseNotes('short\r\nnotes')).toBe('short\nnotes')
    const capped = truncateReleaseNotes('x'.repeat(MAX_RELEASE_NOTES_CHARS + 10))
    expect(capped).toHaveLength(MAX_RELEASE_NOTES_CHARS + 1)
    expect(capped?.endsWith('…')).toBe(true)
  })

  it('prefers the exe asset and falls back to the dmg asset', async () => {    const assets = [
      { name: 'notes.txt', browser_download_url: 'https://example.test/notes.txt' },
      { name: 'DSH-Desktop-2.10.0.dmg', browser_download_url: 'https://example.test/setup.dmg' },
      { name: 'DSH-Desktop-2.10.0-x64-Setup.exe', browser_download_url: 'https://example.test/setup.exe' },
    ]
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.0.0',
      request: async () => releaseResponse('v2.10.0', assets),
    })).resolves.toMatchObject({ status: 'update-available', assetUrl: 'https://example.test/setup.exe' })
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.0.0',
      request: async () => releaseResponse('v2.10.0', assets.slice(0, 2)),
    })).resolves.toMatchObject({ status: 'update-available', assetUrl: 'https://example.test/setup.dmg' })
  })

  it('reports up to date for an equal or older release tag and no asset URL without assets', async () => {
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.10.0',
      request: async () => releaseResponse('v2.10.0'),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion: '2.10.0',
      latestVersion: '2.10.0',
      assetUrl: null,
      releaseUrl: null,
      releaseName: null,
      releaseNotes: null,
      publishedAt: null,
    })
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.11.0',
      request: async () => releaseResponse('2.10.0'),
    })).resolves.toMatchObject({ status: 'up-to-date' })
  })

  it.each([
    ['a prerelease tag', releaseResponse('v2.1.0-rc.1')],
    ['an invalid tag', releaseResponse('not-a-version')],
    ['a missing tag', Response.json({ assets: [] })],
    ['a non-object body', Response.json(['2.1.0'])],
  ])('silently ignores a release body with %s', async (_label, response) => {
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.0.0',
      request: async () => response,
    })).resolves.toBeNull()
  })

  it('silently ignores malformed JSON and non-200 statuses', async () => {
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 403 }),
    })).resolves.toBeNull()
  })

  it('silently ignores declared and streamed oversized release bodies', async () => {
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_RELEASE_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_RELEASE_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each([
    ['owner', 'bad owner', 'deepseek-harness-desktop'],
    ['repo', 'kusesad-1122', '../escape'],
  ])('rejects an invalid %s name before requesting', async (_label, owner, repo) => {
    const request = vi.fn(async () => releaseResponse('v2.1.0'))
    await expect(checkForGithubReleaseUpdate({
      owner,
      repo,
      currentVersion: '2.0.0',
      request,
    })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it('skips invalid installed version before requesting', async () => {
    const request = vi.fn(async () => releaseResponse('v2.1.0'))
    await expect(checkForGithubReleaseUpdate({
      owner: 'kusesad-1122',
      repo: 'deepseek-harness-desktop',
      currentVersion: 'v2.0.0',
      request,
    })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})
