import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { UnifiedDb } from '../src/store/unified-db.ts'
import { migrateFromFiles } from '../src/store/migrate.ts'

const dirs: string[] = []

function tempProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-unified-'))
  dirs.push(dir)
  return dir
}

function openDb(profileDir: string): UnifiedDb {
  const db = new UnifiedDb(join(profileDir, 'unified.db'), { memoryCharLimit: 2200, userCharLimit: 1375, maxCards: 50 })
  db.open()
  dirs.push(profileDir)
  return db
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

describe('UnifiedDb S1 foundation', () => {
  it('creates schema and supports event -> candidate -> fact lifecycle with provenance', () => {
    const profile = tempProfile()
    const db = openDb(profile)
    const event = db.addEvent({ type: 'memory_write', target: 'memory', payload: { content: 'test' } })
    expect(event.id).toMatch(/^[0-9a-z]+-[0-9a-f]+$/)
    expect(db.countEvents()).toBe(1)

    const candidate = db.createCandidate({ eventId: event.id, target: 'memory', content: 'Project uses pnpm', provenance: 'foreground' })
    expect(candidate.status).toBe('pending')
    expect(db.listCandidates('pending')).toHaveLength(1)

    const { fact } = db.approveCandidate(candidate.id)
    expect(fact.content).toBe('Project uses pnpm')
    expect(fact.provenanceEventId).toBe(event.id)
    expect(db.listFacts('memory')).toHaveLength(1)

    const event2 = db.addEvent({ type: 'memory_write', target: 'memory', payload: { content: 'dup' } })
    const c2 = db.createCandidate({ eventId: event2.id, target: 'memory', content: 'Project uses pnpm' })
    const { candidate: c2Updated, fact: existing } = db.approveCandidate(c2.id)
    expect(c2Updated.status).toBe('superseded')
    expect(existing.id).toBe(fact.id)
    expect(db.listFacts('memory')).toHaveLength(1)

    db.close()
  })

  it('enforces per-target char budget on approve', () => {
    const profile = tempProfile()
    const db = new UnifiedDb(join(profile, 'unified.db'), { memoryCharLimit: 10, userCharLimit: 1375, maxCards: 50 })
    db.open()
    const e = db.addEvent({ type: 'migration', payload: {} })
    const c = db.createCandidate({ eventId: e.id, target: 'memory', content: '12345678901' })
    expect(() => db.approveCandidate(c.id)).toThrow(/budget/)
    expect(db.listFacts('memory')).toHaveLength(0)
    db.close()
  })

  it('searches facts with FTS5 and CJK bigram fallback', () => {
    const profile = tempProfile()
    const db = openDb(profile)
    const e = db.addEvent({ type: 'migration', payload: {} })
    for (const content of ['Release process uses check:win-package', 'Terminal prefers PowerShell', '知识卡需要标题和总结']) {
      const c = db.createCandidate({ eventId: e.id, target: 'memory', content })
      db.approveCandidate(c.id)
    }
    const latin = db.searchFacts('release', 'memory', 5)
    expect(latin[0]?.content).toContain('Release')

    const cjk = db.searchFacts('知识卡', 'memory', 5)
    expect(cjk[0]?.content).toContain('知识卡')

    expect(db.searchFacts('PowerShell', undefined, 5)).toHaveLength(1)
    db.close()
  })

  it('stores knowledge cards with FTS hybrid and title dedup', () => {
    const profile = tempProfile()
    const db = openDb(profile)
    const card = db.addKnowledgeCard({ title: 'DSH Desktop 打包', summary: 'check:win-package 是门禁', tags: ['release', 'ci'] })
    expect(card.title).toBe('DSH Desktop 打包')
    expect(() => db.addKnowledgeCard({ title: 'dsh desktop 打包', summary: 'dup', tags: [] })).toThrow(/already exists/)
    expect(db.searchKnowledgeCards('release', 5)).toHaveLength(1)
    expect(db.searchKnowledgeCards('知识', 5)).toHaveLength(0)

    db.addKnowledgeCard({ title: '知识沉淀', summary: '通过 /distill 沉淀', tags: ['knowledge'] })
    expect(db.searchKnowledgeCards('知识', 5)[0]?.title).toBe('知识沉淀')
    db.close()
  })

  it('supports document chunk upsert and FTS search (S2)', () => {
    const profile = tempProfile()
    const db = openDb(profile)
    db.upsertDocumentChunks('/docs/guide.md', 'hash1', ['第一段关于 AI', '第二段关于构建'])
    expect(db.getDocumentChunks('/docs/guide.md')).toHaveLength(2)
    expect(db.searchDocumentChunks('AI', 5)).toHaveLength(1)
    db.upsertDocumentChunks('/docs/guide.md', 'hash2', ['全新内容'])
    expect(db.getDocumentChunks('/docs/guide.md')).toHaveLength(1)
    db.close()
  })

  it('maintains relations graph and audit log', () => {
    const profile = tempProfile()
    const db = openDb(profile)
    db.upsertRelation('card:1', 'card:2', 'related', 0.8)
    expect(db.listRelations()).toHaveLength(1)
    db.audit({ origin: 'test', target: 'memory', outcome: 'ok' })
    expect(db.listAudit(5)).toHaveLength(1)
    expect(db.stats()).toEqual(expect.objectContaining({ events: 0, facts: 0 }))
    db.close()
  })

  it('syncs file projection and migrates legacy files idempotently', async () => {
    const profile = tempProfile()
    const memoryDir = join(profile, 'memory')
    const knowledgeDir = join(profile, 'knowledge')
    mkdirSync(memoryDir, { recursive: true })
    mkdirSync(knowledgeDir, { recursive: true })
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'Entry A\n§\nEntry B', 'utf8')
    writeFileSync(join(memoryDir, 'USER.md'), 'User is captain', 'utf8')
    writeFileSync(join(knowledgeDir, 'knowledge.json'), JSON.stringify({ version: 1, cards: [{ id: 'k1', title: 'Old Card', summary: 'kept', tags: ['a'], source: 'manual', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }), 'utf8')

    const db = openDb(profile)
    const first = await migrateFromFiles(profile, db)
    expect(first.factsImported).toBe(3)
    expect(first.cardsImported).toBe(1)
    expect(db.listFacts('memory')).toHaveLength(2)
    expect(db.listKnowledgeCards()).toHaveLength(1)

    const second = await migrateFromFiles(profile, db)
    expect(second.factsImported).toBe(0)
    expect(second.skippedFacts).toBe(3)

    await db.syncProjection(memoryDir)
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toContain('Entry A')
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toContain('Entry B')

    db.close()
  })

  it('projects facts into FTS after backfill', () => {
    const profile = tempProfile()
    const db = openDb(profile)
    const e = db.addEvent({ type: 'migration', payload: {} })
    const c = db.createCandidate({ eventId: e.id, target: 'memory', content: 'Migrated fact for backfill' })
    db.approveCandidate(c.id)
    db.close()
    const db2 = openDb(profile)
    expect(db2.searchFacts('backfill', 'memory', 5)).toHaveLength(1)
    db2.close()
  })
})
