import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { KnowledgeStore, parseDistillOutput, tokenizeQuery, type Config as KnowledgeConfig } from '../src/knowledge.ts'
import { renderKnowledgeContext } from '../src/knowledge-web.ts'
import { KNOWLEDGE_NEWS_ROUTE, mountKnowledgeRoutes } from '../src/knowledge-routes.ts'
import { supportsEffort } from '../src/reasoning-default.ts'
import type { Context } from '@deepseek-ai/cordis'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-knowledge-'))
  dirs.push(dir)
  return dir
}

function createStore(dir: string, overrides: Partial<KnowledgeConfig> = {}): KnowledgeStore {
  const defaultConfig: KnowledgeConfig = {
    enabled: true,
    maxCards: 50,
    titleCharLimit: 80,
    cardCharLimit: 600,
    maxTags: 8,
    tagCharLimit: 24,
    retrieveTopK: 4,
    autoRetrieval: true,
  }
  const config: KnowledgeConfig = {
    ...defaultConfig,
    ...overrides,
  }
  return new KnowledgeStore(dir, config)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('KnowledgeStore', () => {
  it('adds cards and persists them atomically to knowledge.json', async () => {
    const store = createStore(tempDir())
    await store.loadFromDisk()
    const result = await store.addCard(
      { title: 'DSH Desktop 打包', summary: '桌面发行使用 check:win-package 作为 CI 门禁。', tags: ['release', 'ci'] },
      'distill',
    )
    expect(result.success).toBe(true)
    expect(store.count()).toBe(1)
    const doc = JSON.parse(readFileSync(join(store.dir, 'knowledge.json'), 'utf8'))
    expect(doc.version).toBe(1)
    expect(doc.cards[0].title).toBe('DSH Desktop 打包')
  })

  it('deduplicates by case-insensitive title and reports the existing card', async () => {
    const store = createStore(tempDir())
    await store.loadFromDisk()
    await store.addCard({ title: 'Shell 偏好', summary: '默认使用 git bash。', tags: ['env'] }, 'manual')
    const duplicate = await store.addCard({ title: 'shell 偏好', summary: '另一个内容。' }, 'model')
    expect(duplicate.success).toBe(true)
    expect(duplicate.card?.summary).toBe('默认使用 git bash。')
    expect(store.count()).toBe(1)
  })

  it('enforces the maxCards cap', async () => {
    const store = createStore(tempDir(), { maxCards: 2 })
    await store.loadFromDisk()
    await store.addCard({ title: 'A', summary: 'a' }, 'manual')
    await store.addCard({ title: 'B', summary: 'b' }, 'manual')
    const full = await store.addCard({ title: 'C', summary: 'c' }, 'manual')
    expect(full.success).toBe(false)
    expect(full.error).toContain('full')
    expect(store.count()).toBe(2)
  })

  it('updates and deletes by id', async () => {
    const store = createStore(tempDir())
    await store.loadFromDisk()
    const added = await store.addCard({ title: '主题', summary: '旧内容', tags: ['a'] }, 'manual')
    const id = added.card?.id
    expect(id).toBeDefined()
    const updated = await store.updateCard(id!, { title: '主题', summary: '新内容', tags: ['a', 'b'] }, 'manual')
    expect(updated.success).toBe(true)
    expect(store.cardById(id!)?.summary).toBe('新内容')
    expect(store.cardById(id!)?.tags).toEqual(['a', 'b'])
    const deleted = await store.deleteCard(id!, 'manual')
    expect(deleted.success).toBe(true)
    expect(store.count()).toBe(0)
  })

  it('rejects updates that collide with another title', async () => {
    const store = createStore(tempDir())
    await store.loadFromDisk()
    await store.addCard({ title: '第一条', summary: 'one' }, 'manual')
    const second = await store.addCard({ title: '第二条', summary: 'two' }, 'manual')
    const conflict = await store.updateCard(second.card!.id, { title: '第一条', summary: 'two' }, 'manual')
    expect(conflict.success).toBe(false)
    expect(conflict.error).toContain('already uses the title')
  })

  it('searches by keyword over tags, title, and summary', async () => {
    const store = createStore(tempDir())
    await store.loadFromDisk()
    await store.addCard({ title: '发布流程', summary: '打 tag 前先跑 check:win-package', tags: ['release'] }, 'manual')
    await store.addCard({ title: '终端', summary: 'PowerShell 与 git bash 都可用', tags: ['shell'] }, 'manual')
    const byTag = store.search('release', 5)
    expect(byTag).toHaveLength(1)
    expect(byTag[0]?.title).toBe('发布流程')
    const byTitle = store.search('终端', 5)
    expect(byTitle[0]?.title).toBe('终端')
    const none = store.search('不存在的关键词', 5)
    expect(none).toHaveLength(0)
  })

  it('retrieves top-K by relevance and newest-first on an empty query', async () => {
    const store = createStore(tempDir())
    await store.loadFromDisk()
    await store.addCard({ title: 'Alpha', summary: '关于 git 的知识', tags: ['git'] }, 'manual')
    await store.addCard({ title: 'Beta', summary: '关于 git 与 ci 的知识', tags: ['git', 'ci'] }, 'manual')
    const retrieved = store.retrieve('git ci', 4)
    expect(retrieved[0]?.title).toBe('Beta') // tag match on both terms
    expect(retrieved).toHaveLength(2)
    const newest = store.retrieve('', 2)
    expect(newest).toHaveLength(2)
    expect(newest[0]?.title).toBe('Beta')
  })
})

describe('knowledge news route', () => {
  it('returns newest knowledge cards in the client NewsItemView shape', async () => {
    const store = createStore(tempDir())
    await store.loadFromDisk()
    const first = await store.addCard({ title: 'Older', summary: 'first' }, 'manual')
    const second = await store.addCard({ title: 'Newer', summary: 'second' }, 'manual')
    expect(first.card).toBeDefined()
    expect(second.card).toBeDefined()

    const routes = new Map<string, (request: unknown, response: unknown) => void | Promise<void>>()
    const host = {
      webServer: {
        register: ({ path, handler }: { path: string, handler: (request: unknown, response: unknown) => void | Promise<void> }) => {
          routes.set(path, handler)
          return () => { routes.delete(path) }
        },
      },
      effect: () => {},
    }
    const dispose = mountKnowledgeRoutes(host as never, store, {
      enabled: true, maxCards: 50, titleCharLimit: 80, cardCharLimit: 600, maxTags: 8,
      tagCharLimit: 24, retrieveTopK: 4, autoRetrieval: true,
    })
    const handler = routes.get(KNOWLEDGE_NEWS_ROUTE)
    expect(handler).toBeDefined()
    const response = new EventEmitter() as EventEmitter & { status?: number, headers?: unknown, body?: string, writeHead(status: number, headers: unknown): void, end(body: string): void }
    response.writeHead = (status, headers) => { response.status = status; response.headers = headers }
    response.end = (body) => { response.body = body }
    await handler?.({ url: '/dsh-desktop/knowledge/news?limit=1', headers: {} }, response)

    expect(response.status).toBe(200)
    const payload = JSON.parse(response.body ?? '{}')
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toEqual(expect.objectContaining({
      id: second.card?.id,
      title: 'Newer',
      summary: 'second',
      publishedAt: second.card?.updatedAt,
    }))
    dispose()
  })
})

describe('tokenizeQuery', () => {
  it('handles latin words and CJK bigrams', () => {
    const latin = tokenizeQuery('release ci')
    expect(latin).toContain('release')
    expect(latin).toContain('ci')
    const cjk = tokenizeQuery('知识卡')
    expect(cjk).toEqual(['知识', '识卡'])
    const single = tokenizeQuery('卡')
    expect(single).toEqual(['卡'])
  })
})

describe('parseDistillOutput', () => {
  it('accepts "Nothing to save."', () => {
    expect(parseDistillOutput('Nothing to save.')).toEqual([])
  })

  it('parses a strict cards JSON and bounds fields', () => {
    const cards = parseDistillOutput('{"cards":[{"title":"标题","summary":"内容","tags":["a","b"]}]}')
    expect(cards).toEqual([{ title: '标题', summary: '内容', tags: ['a', 'b'] }])
  })

  it('skips malformed records and caps tag count', () => {
    const cards = parseDistillOutput('{"cards":[{"title":"t","summary":"s","tags":["1","2","3","4","5","6","7","8","9"]},{"title":"","summary":"x"}]}')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.tags).toHaveLength(8)
  })

  it('rejects unparsable output', () => {
    expect(() => parseDistillOutput('some prose')).toThrow('unparsable output')
  })
})

describe('renderKnowledgeContext', () => {
  it('renders a fenced, labelled knowledge context', () => {
    const text = renderKnowledgeContext([
      { id: '1', title: '打包', summary: 'check:win-package', tags: ['ci'] },
    ])
    expect(text).toContain('<knowledge-context>')
    expect(text).toContain('Auto-retrieved from the knowledge base')
    expect(text).toContain('- 打包: check:win-package')
    expect(text).toContain('标签: ci')
  })
})

describe('supportsEffort (reasoning-default)', () => {
  interface FakeLlm {
    resolveModelInfo(provider: string, model: string): Promise<unknown>
  }

  it('returns true only for a level the model advertises', async () => {
    const ctx = {
      llm: {
        resolveModelInfo: async (provider: string, model: string) => ({
          provider,
          id: model,
          name: model,
          reasoning: { efforts: [{ id: 'off' }, { id: 'high' }, { id: 'max' }] },
        }),
      },
    } as unknown as Context
    await expect(supportsEffort(ctx, 'fake-provider-a', 'reasoner', 'high', new AbortController().signal)).resolves.toBe(true)
    await expect(supportsEffort(ctx, 'fake-provider-a', 'reasoner', 'low', new AbortController().signal)).resolves.toBe(false)
  })

  it('returns false for a model without reasoning metadata', async () => {
    const ctx = {
      llm: {
        resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: model }),
      },
    } as unknown as Context
    await expect(supportsEffort(ctx, 'fake-provider-b', 'chat', 'high', new AbortController().signal)).resolves.toBe(false)
  })

  it('returns false when the lookup throws (never breaks requests)', async () => {
    const ctx = {
      llm: {
        resolveModelInfo: async () => { throw new Error('lookup failed') },
      },
    } as unknown as Context
    await expect(supportsEffort(ctx, 'fake-provider-c', 'broken', 'high', new AbortController().signal)).resolves.toBe(false)
  })

  it('serves repeated lookups from the cache', async () => {
    let calls = 0
    const llm: FakeLlm = {
      resolveModelInfo: async () => {
        calls += 1
        return { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }
      },
    }
    const ctx = { llm } as unknown as Context
    const signal = new AbortController().signal
    await supportsEffort(ctx, 'fake-provider-d', 'cached', 'high', signal)
    await supportsEffort(ctx, 'fake-provider-d', 'cached', 'high', signal)
    await supportsEffort(ctx, 'fake-provider-d', 'cached', 'off', signal)
    expect(calls).toBe(1)
  })
})
