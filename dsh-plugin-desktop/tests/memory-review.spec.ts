import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryStore } from '../src/memory.ts'
import {
  extractReviewDigest,
  MemoryReviewer,
  parseReviewOutput,
  ReviewConfig,
  type ReviewConfig as ReviewConfigShape,
} from '../src/memory-review.ts'

const reviewConfig: ReviewConfigShape = {
  reviewEnabled: true,
  reviewInterval: 6,
  reviewCooldownMs: 60_000,
  reviewTimeoutMs: 5_000,
  reviewMaxDigestChars: 8_000,
  reviewMaxOutputTokens: 512,
}

function textStreamChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function makeAgent(events: Array<Record<string, unknown>>): Agent {
  return {
    options: { provider: 'mock', model: 'mock' },
    session: { id: 'session-1', events },
  } as unknown as Agent
}

function makeStore(): { store: MemoryStore, applyOperations: ReturnType<typeof vi.fn> } {
  const applyOperations = vi.fn(async (_target: string, _ops: readonly unknown[]) => ({ success: true }))
  return { store: { applyOperations } as unknown as MemoryStore, applyOperations }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseReviewOutput', () => {
  it('accepts the exact Nothing to save. marker', () => {
    expect(parseReviewOutput('Nothing to save.')).toEqual({ memory: [], user: [] })
    expect(parseReviewOutput('  Nothing to save  ')).toEqual({ memory: [], user: [] })
  })

  it('parses strict JSON and trims bounded string entries', () => {
    const result = parseReviewOutput(JSON.stringify({
      memory: [' Project uses pnpm ', 'x'.repeat(900)],
      user: [' 用户喜欢简洁回复 '],
    }))
    expect(result.memory).toEqual(['Project uses pnpm', 'x'.repeat(500)])
    expect(result.user).toEqual(['用户喜欢简洁回复'])
  })

  it('tolerates a wrapped code-fence-like prefix and suffix', () => {
    const result = parseReviewOutput('```json\n{"memory":["Fact"],"user":[]}\n```')
    expect(result.memory).toEqual(['Fact'])
  })

  it('rejects non-JSON output with a bounded error', () => {
    expect(() => parseReviewOutput('just some prose')).toThrow(/unparsable output/)
  })
})

describe('extractReviewDigest', () => {
  it('keeps human user messages, skips plugin-injected ones, and caps assistant text', () => {
    const agent = makeAgent([
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'y'.repeat(1200) }] } } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'INJECTED' }], source: { kind: 'plugin', plugin: 'x' } } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'remember me' }], source: { kind: 'user' } } },
    ])
    const digest = extractReviewDigest(agent, 8000)
    expect(digest).toContain('用户: hello')
    expect(digest).toContain('用户: remember me')
    expect(digest).not.toContain('INJECTED')
    expect(digest).toContain('助手: ')
    expect(digest).not.toContain('y'.repeat(1200))
    expect(digest).toContain('y'.repeat(600))
  })

  it('honors the character cap by keeping the newest tail', () => {
    const events = Array.from({ length: 12 }, (_, index) => ({
      type: 'user/message',
      data: { content: [{ type: 'text', text: `message ${String(index)} `.repeat(40) }], source: { kind: 'user' } },
    }))
    const digest = extractReviewDigest(makeAgent(events), 500)
    expect(digest.length).toBeLessThanOrEqual(500)
    expect(digest).toContain('message 11')
  })
})

describe('MemoryReviewer turn rhythm', () => {
  it('reviews after N user turns, detached, and writes through the guarded store', async () => {
    const { store, applyOperations } = makeStore()
    const reviewer = new MemoryReviewer(await mkdtemp(join(tmpdir(), 'dsh-review-')))
    let listener: ((payload: { agent: Agent }) => void) | undefined
    const warnings: unknown[][] = []
    const stream = vi.fn(async function * () {
      yield * textStreamChunks(JSON.stringify({ memory: ['项目使用 pnpm'], user: ['用户喜欢中文'] }))
    })
    const ctx = {
      on: (_type: string, handler: (payload: { agent: Agent }) => void) => {
        listener = handler
        return () => {}
      },
      llm: { stream },
      logger: { warn: (...args: unknown[]) => { warnings.push(args) }, info: () => {} },
    } as unknown as Context

    reviewer.attach(ctx, store, reviewConfig)
    const agent = makeAgent([
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    ])

    for (let turn = 1; turn <= 5; turn++) listener!({ agent })
    expect(stream).not.toHaveBeenCalled()

    listener!({ agent })
    await vi.waitFor(() => { expect(stream).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(applyOperations).toHaveBeenCalledTimes(2) })
    expect(applyOperations.mock.calls[0]![0]).toBe('memory')
    expect(applyOperations.mock.calls[1]![0]).toBe('user')
    expect(warnings).toEqual([])
  })

  it('does not review again inside the cooldown window', async () => {
    const { store, applyOperations } = makeStore()
    const reviewer = new MemoryReviewer(await mkdtemp(join(tmpdir(), 'dsh-review-')))
    let listener: ((payload: { agent: Agent }) => void) | undefined
    const stream = vi.fn(async function * () {
      yield * textStreamChunks(JSON.stringify({ memory: ['one'], user: [] }))
    })
    const ctx = {
      on: (_type: string, handler: (payload: { agent: Agent }) => void) => {
        listener = handler
        return () => {}
      },
      llm: { stream },
      logger: { warn: (..._args: unknown[]) => {}, info: () => {} },
    } as unknown as Context

    reviewer.attach(ctx, store, reviewConfig)
    const agent = makeAgent([
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    ])

    for (let turn = 1; turn <= 6; turn++) listener!({ agent })
    await vi.waitFor(() => { expect(stream).toHaveBeenCalledTimes(1) })

    for (let turn = 1; turn <= 6; turn++) listener!({ agent })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stream).toHaveBeenCalledTimes(1)
    expect(applyOperations).toHaveBeenCalledTimes(1)
  })

  it('skips review entirely when disabled', async () => {
    const { store, applyOperations } = makeStore()
    const reviewer = new MemoryReviewer(await mkdtemp(join(tmpdir(), 'dsh-review-')))
    const stream = vi.fn()
    const ctx = { on: () => () => {}, llm: { stream }, logger: { warn: () => {} } } as unknown as Context
    reviewer.attach(ctx, store, { ...reviewConfig, reviewEnabled: false })
    expect(stream).not.toHaveBeenCalled()
    expect(applyOperations).not.toHaveBeenCalled()
  })

  it('accepts the validated review defaults', () => {
    expect(ReviewConfig({} as ReviewConfigShape)).toEqual({ ...reviewConfig, reviewTimeoutMs: 60_000 })
  })
})
