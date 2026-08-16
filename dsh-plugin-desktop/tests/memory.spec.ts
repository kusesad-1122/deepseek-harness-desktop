import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  Config,
  MemoryStore,
  inject,
  name,
  type Config as MemoryConfig,
} from '../src/memory.ts'

const defaultConfig: MemoryConfig = {
  memoryEnabled: true,
  userProfileEnabled: true,
  memoryCharLimit: 2200,
  userCharLimit: 1375,
  reviewEnabled: true,
  reviewInterval: 6,
  reviewCooldownMs: 60_000,
  reviewTimeoutMs: 60_000,
  reviewMaxDigestChars: 8_000,
  reviewMaxOutputTokens: 512,
}

async function makeStore(limits: Partial<Pick<MemoryConfig, 'memoryCharLimit' | 'userCharLimit'>> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  const store = new MemoryStore(join(root, 'memory'), {
    memoryCharLimit: limits.memoryCharLimit ?? defaultConfig.memoryCharLimit,
    userCharLimit: limits.userCharLimit ?? defaultConfig.userCharLimit,
  })
  return { root, store }
}

afterEach(async () => {
  vi.useRealTimers()
})

describe('memory store', () => {
  it('loads, deduplicates, and renders a frozen snapshot with budget headers', async () => {
    const { root, store } = await makeStore()
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'memory', 'MEMORY.md'), 'Project uses tabs\n§\nProject uses tabs\n§\nUser prefers terse replies', 'utf8')
    await writeFile(join(root, 'memory', 'USER.md'), 'Timezone: Asia/Shanghai', 'utf8')
    await store.loadFromDisk()

    const snapshot = store.snapshotText({ memory: true, user: true })
    expect(snapshot).toContain('MEMORY (your personal notes)')
    expect(snapshot).toContain('USER PROFILE (who the user is)')
    expect(snapshot).toContain('Project uses tabs')
    expect(snapshot.match(/Project uses tabs/g)).toHaveLength(1)
    expect(store.currentEntries('memory')).toEqual(['Project uses tabs', 'User prefers terse replies'])
  })

  it('keeps the snapshot frozen while writes land on disk immediately', async () => {
    const { root, store } = await makeStore()
    await store.loadFromDisk()
    const before = store.snapshotText({ memory: true, user: true })

    const result = await store.applySingle('memory', { action: 'add', content: 'Runtime is pinned to 47f9438' })
    expect(result.success).toBe(true)
    expect(store.snapshotText({ memory: true, user: true })).toBe(before)
    expect(store.currentEntries('memory')).toEqual(['Runtime is pinned to 47f9438'])
    expect(await readFile(join(root, 'memory', 'MEMORY.md'), 'utf8')).toBe('Runtime is pinned to 47f9438')
  })

  it('rejects exact duplicates and enforces the char budget with current entries', async () => {
    const { store } = await makeStore({ memoryCharLimit: 10 })
    await store.loadFromDisk()
    await store.applySingle('memory', { action: 'add', content: 'aaaa' })

    const duplicate = await store.applySingle('memory', { action: 'add', content: 'aaaa' })
    expect(duplicate).toMatchObject({ success: true, message: expect.stringContaining('Applied') })

    const overflow = await store.applySingle('memory', { action: 'add', content: 'bbbbbbb' })
    expect(overflow.success).toBe(false)
    expect(overflow.currentEntries).toEqual(['aaaa'])
    expect(overflow.usage).toContain('4/10')
    expect(overflow.error).toContain('over the limit')
  })

  it('degrades to a terminal result after three consecutive consolidation failures', async () => {
    const { store } = await makeStore({ memoryCharLimit: 5 })
    await store.loadFromDisk()
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await store.applySingle('memory', { action: 'add', content: 'aaaaaa' })
      expect(result.success).toBe(false)
      expect(result.done).toBeUndefined()
    }
    const fourth = await store.applySingle('memory', { action: 'add', content: 'aaaaaa' })
    expect(fourth.success).toBe(false)
    expect(fourth.done).toBe(true)
    expect(fourth.error).toContain('Stop retrying memory calls')
  })

  it('replaces and removes by unique substring and reports ambiguity', async () => {
    const { store } = await makeStore()
    await store.loadFromDisk()
    await store.applySingle('memory', { action: 'add', content: 'Shell: zsh with oh-my-zsh' })
    await store.applySingle('memory', { action: 'add', content: 'Editor: VS Code' })

    const ambiguous = await store.applySingle('memory', { action: 'remove', oldText: 'o' })
    expect(ambiguous.success).toBe(false)
    expect(ambiguous.error).toContain('Multiple entries matched')

    const replaced = await store.applySingle('memory', { action: 'replace', oldText: 'zsh', content: 'Shell: fish' })
    expect(replaced.success).toBe(true)
    expect(store.currentEntries('memory')).toEqual(['Shell: fish', 'Editor: VS Code'])

    const missing = await store.applySingle('memory', { action: 'replace', oldText: 'nvim', content: 'Editor: Neovim' })
    expect(missing.success).toBe(false)
    expect(missing.currentEntries).toEqual(['Shell: fish', 'Editor: VS Code'])
  })

  it('applies atomic batches against the final budget, all-or-nothing', async () => {
    const { root, store } = await makeStore({ memoryCharLimit: 10 })
    await store.loadFromDisk()
    await store.applySingle('memory', { action: 'add', content: 'aaaa' })

    const ok = await store.applyOperations('memory', [
      { action: 'remove', oldText: 'aaaa' },
      { action: 'add', content: 'bbbbbbbbbb' },
    ])
    expect(ok.success).toBe(true)
    expect(store.currentEntries('memory')).toEqual(['bbbbbbbbbb'])

    const aborted = await store.applyOperations('memory', [
      { action: 'add', content: 'c' },
      { action: 'replace', oldText: 'missing', content: 'x' },
    ])
    expect(aborted.success).toBe(false)
    expect(await readFile(join(root, 'memory', 'MEMORY.md'), 'utf8')).toBe('bbbbbbbbbb')
  })

  it('refuses to rewrite drifted files and preserves a backup snapshot', async () => {
    const { root, store } = await makeStore({ memoryCharLimit: 10 })
    await mkdir(join(root, 'memory'), { recursive: true })
    const path = join(root, 'memory', 'MEMORY.md')
    const drifted = 'free-form content appended by a shell, longer than the store budget'
    await writeFile(path, drifted, 'utf8')
    await store.loadFromDisk()

    const result = await store.applySingle('memory', { action: 'replace', oldText: 'shell', content: 'x' })
    expect(result.success).toBe(false)
    expect(result.driftBackup).toContain('MEMORY.md.bak.')
    expect(await readFile(path, 'utf8')).toBe(drifted)
    expect(await readFile(result.driftBackup!, 'utf8')).toBe(drifted)
  })

  it('isolates the two stores and their independent budgets', async () => {
    const { store } = await makeStore({ memoryCharLimit: 20, userCharLimit: 5 })
    await store.loadFromDisk()
    await store.applySingle('user', { action: 'add', content: 'Alice' })
    const overflow = await store.applySingle('user', { action: 'add', content: 'Bob' })
    expect(overflow.success).toBe(false)
    await store.applySingle('memory', { action: 'add', content: 'a'.repeat(20) })
    expect(store.currentEntries('memory')).toHaveLength(1)
    expect(store.currentEntries('user')).toEqual(['Alice'])
  })
})

describe('memory Host plugin', () => {
  it('validates the packaged policy defaults', () => {
    expect(name).toBe('desktop-memory')
    expect(inject).toEqual(['desktopProfiles'])
    expect(Config({} as MemoryConfig)).toEqual({
      memoryEnabled: true,
      userProfileEnabled: true,
      memoryCharLimit: 2200,
      userCharLimit: 1375,
      reviewEnabled: true,
      reviewInterval: 6,
      reviewCooldownMs: 60_000,
      reviewTimeoutMs: 60_000,
      reviewMaxDigestChars: 8_000,
      reviewMaxOutputTokens: 512,
    })
    expect(() => Config({ memoryCharLimit: 0 } as MemoryConfig)).toThrow()
  })

  it('registers a frozen prompt section and the memory tool after effect startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'))
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'memory', 'MEMORY.md'), 'Seed entry', 'utf8')

    const sections: Array<{ name: string, order: number, text: string }> = []
    const tools: ToolDefinition[] = []
    const warnings: unknown[][] = []
    let disposer: (() => void) | undefined
    const ctx = {
      desktopProfiles: {
        current: { name: 'test', dir: root },
        list: () => [],
        select: async () => {},
      },
      systemPrompt: {
        section: (section: { name: string, order: number, text: string }) => {
          sections.push(section)
          return () => {}
        },
      },
      tools: {
        register: (definition: ToolDefinition) => {
          tools.push(definition)
          return () => {}
        },
      },
      commands: {
        register: (_definition: { name: string, description: string, handler: () => unknown }) => () => {},
      },
      on: (_type: string, _listener: (payload: never) => void) => () => {},
      logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
      effect: (register: () => Promise<() => void>) => {
        void register().then((release) => { disposer = release })
      },
    } as unknown as Context

    apply(ctx, defaultConfig)
    await vi.waitFor(() => { expect(disposer).toBeDefined() })

    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({ name: 'memory', order: 300 })
    expect(sections[0]!.text).toContain('Seed entry')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('memory')

    await tools[0]!.execute({ action: 'add', content: 'Remembered through the tool' }, { signal: new AbortController().signal } as never)
    expect(await readFile(join(root, 'memory', 'MEMORY.md'), 'utf8')).toContain('Remembered through the tool')
    expect(warnings).toEqual([])
    disposer!()
    await rm(root, { recursive: true, force: true })
  })

  it('continues with an empty store when the profile memory directory cannot be created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'))
    await writeFile(join(root, 'memory'), 'not a directory', 'utf8')
    const sections: Array<{ name: string }> = []
    const tools: ToolDefinition[] = []
    const warnings: unknown[][] = []
    const ctx = {
      desktopProfiles: { current: { name: 'test', dir: root }, list: () => [], select: async () => {} },
      systemPrompt: { section: (section: { name: string }) => { sections.push(section); return () => {} } },
      tools: { register: (definition: ToolDefinition) => { tools.push(definition); return () => {} } },
      commands: { register: () => () => {} },
      on: () => () => {},
      logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
      effect: (register: () => Promise<() => void>) => { void register() },
    } as unknown as Context

    apply(ctx, defaultConfig)
    await vi.waitFor(() => { expect(tools).toHaveLength(1) })
    expect(sections).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    await rm(root, { recursive: true, force: true })
  })
})
