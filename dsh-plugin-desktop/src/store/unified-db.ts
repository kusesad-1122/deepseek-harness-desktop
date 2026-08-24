/**
 * Unified SQLite fact layer for DSH Desktop (S1 foundation).
 *
 * Consolidates: events (append-only log), candidates (model-generated, pending review),
 * facts (approved MEMORY/USER entries), knowledge_cards (structured B), document_chunks,
 * relations (projected graph edges), and audit. Uses `node:sqlite` (Node 22+) with WAL
 * and FTS5. Keeps `MEMORY.md` / `USER.md` / `knowledge.json` as compatible projections
 * so the existing file contract never breaks.
 *
 * Design mirrors the approved architecture:
 * - OpenViking: session lifecycle + replayable queue -> `events` + `candidates`
 * - hindsight: fact extraction/conflict/version + knowledge-page projection + recall/reflect split -> `facts` versioning + `candidates` status
 * - WeKnora: hybrid retrieval + neighbourhood reading + tool contract -> FTS5 BM25 + document_chunks + same-origin 4 KiB routes
 */

import { mkdirSync } from 'node:fs'
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export type FactTarget = 'memory' | 'user'
export type CandidateStatus = 'pending' | 'approved' | 'rejected' | 'superseded'
export type EventType = 'memory_write' | 'knowledge_write' | 'session' | 'file' | 'migration'
export type KnowledgeSource = 'manual' | 'distill' | 'model'

export interface UnifiedDbOptions {
  readonly memoryCharLimit: number
  readonly userCharLimit: number
  readonly maxCards: number
}

export interface EventRecord {
  readonly id: string
  readonly type: EventType
  readonly target: string | null
  readonly payload: string // JSON
  readonly sessionId: string | null
  readonly createdAt: string
}

export interface CandidateRecord {
  readonly id: string
  readonly eventId: string
  readonly target: FactTarget
  readonly content: string
  readonly status: CandidateStatus
  readonly provenance: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface FactRecord {
  readonly id: string
  readonly target: FactTarget
  readonly content: string
  readonly version: number
  readonly provenanceEventId: string | null
  readonly provenanceCandidateId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface KnowledgeCardRecord {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly tags: readonly string[] // JSON array in DB
  readonly source: KnowledgeSource
  readonly createdAt: string
  readonly updatedAt: string
}

export interface DocumentChunkRecord {
  readonly id: string
  readonly path: string
  readonly hash: string
  readonly chunkIndex: number
  readonly content: string
  readonly updatedAt: string
}

export interface RelationRecord {
  readonly sourceId: string
  readonly targetId: string
  readonly type: string
  readonly weight: number
}

const SCHEMA_VERSION = 1

function nowIso(): string {
  return new Date().toISOString()
}

function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function isFactTarget(value: unknown): value is FactTarget {
  return value === 'memory' || value === 'user'
}

/**
 * SQLite-backed unified store. Synchronous `DatabaseSync` is wrapped in a thin
 * async-friendly facade so Cordis `effect` callers can `await` without blocking.
 */
export class UnifiedDb {
  private db: DatabaseSync | null = null
  private readonly path: string
  private readonly options: UnifiedDbOptions

  constructor(dbPath: string, options: UnifiedDbOptions) {
    this.path = dbPath
    this.options = options
  }

  get filePath(): string {
    return this.path
  }

  /** Open (creating parent dirs) and initialise schema. Idempotent. */
  open(): void {
    if (this.db !== null) return
    mkdirSync(join(this.path, '..'), { recursive: true })
    this.db = new DatabaseSync(this.path)
    // Durability + concurrency for a single writer + many readers (panel).
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;')
    this.initSchema()
  }

  close(): void {
    if (this.db === null) return
    try { this.db.close() } catch {}
    this.db = null
  }

  isOpen(): boolean {
    return this.db !== null
  }

  private requireDb(): DatabaseSync {
    if (this.db === null) throw new Error('UnifiedDb not open')
    return this.db
  }

  private initSchema(): void {
    const db = this.requireDb()
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        target TEXT,
        payload TEXT NOT NULL,
        sessionId TEXT,
        createdAt TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS candidates(
        id TEXT PRIMARY KEY,
        eventId TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        target TEXT NOT NULL CHECK(target IN ('memory','user')),
        content TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','superseded')),
        provenance TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS facts(
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL CHECK(target IN ('memory','user')),
        content TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL DEFAULT 1,
        provenanceEventId TEXT REFERENCES events(id),
        provenanceCandidateId TEXT REFERENCES candidates(id),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_cards(
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL UNIQUE COLLATE NOCASE,
        summary TEXT NOT NULL,
        tags TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('manual','distill','model')),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS document_chunks(
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        chunkIndex INTEGER NOT NULL,
        content TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        UNIQUE(path, chunkIndex)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS relations(
        sourceId TEXT NOT NULL,
        targetId TEXT NOT NULL,
        type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        PRIMARY KEY(sourceId, targetId, type)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit(
        id TEXT PRIMARY KEY,
        time TEXT NOT NULL,
        origin TEXT NOT NULL,
        target TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error TEXT,
        details TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_events_createdAt ON events(createdAt);
      CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
      CREATE INDEX IF NOT EXISTS idx_candidates_eventId ON candidates(eventId);
      CREATE INDEX IF NOT EXISTS idx_facts_target ON facts(target);
      CREATE INDEX IF NOT EXISTS idx_facts_content ON facts(content);
      CREATE INDEX IF NOT EXISTS idx_knowledge_cards_title ON knowledge_cards(title);
      CREATE INDEX IF NOT EXISTS idx_document_chunks_path ON document_chunks(path);
      CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(time);
    `)

    // FTS5 virtual tables (content sync via triggers). Use unicode61 to keep
    // latin tokenisation; CJK fallback is handled in search with LIKE/bigram.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_facts USING fts5(content, target, tokenize='unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_cards USING fts5(title, summary, tags, tokenize='unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(content, path, tokenize='unicode61');
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO fts_facts(rowid, content, target) VALUES (new.rowid, new.content, new.target);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_facts_ad AFTER DELETE ON facts BEGIN
        DELETE FROM fts_facts WHERE rowid=old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_facts_au AFTER UPDATE ON facts BEGIN
        DELETE FROM fts_facts WHERE rowid=old.rowid;
        INSERT INTO fts_facts(rowid, content, target) VALUES (new.rowid, new.content, new.target);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_cards_ai AFTER INSERT ON knowledge_cards BEGIN
        INSERT INTO fts_cards(rowid, title, summary, tags) VALUES (new.rowid, new.title, new.summary, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_cards_ad AFTER DELETE ON knowledge_cards BEGIN
        DELETE FROM fts_cards WHERE rowid=old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_cards_au AFTER UPDATE ON knowledge_cards BEGIN
        DELETE FROM fts_cards WHERE rowid=old.rowid;
        INSERT INTO fts_cards(rowid, title, summary, tags) VALUES (new.rowid, new.title, new.summary, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunks_ai AFTER INSERT ON document_chunks BEGIN
        INSERT INTO fts_chunks(rowid, content, path) VALUES (new.rowid, new.content, new.path);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunks_ad AFTER DELETE ON document_chunks BEGIN
        DELETE FROM fts_chunks WHERE rowid=old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_chunks_au AFTER UPDATE ON document_chunks BEGIN
        DELETE FROM fts_chunks WHERE rowid=old.rowid;
        INSERT INTO fts_chunks(rowid, content, path) VALUES (new.rowid, new.content, new.path);
      END;
    `)

    const row = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version') as { value: string } | undefined
    if (row === undefined) {
      db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(SCHEMA_VERSION))
    } else if (row.value !== String(SCHEMA_VERSION)) {
      // Future migrations go here; for now keep single version and no auto-upgrade.
      db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(SCHEMA_VERSION), 'schema_version')
    }

    // Backfill FTS if tables existed before FT was added (e.g. upgraded install).
    this.backfillFtsIfEmpty()
  }

  private backfillFtsIfEmpty(): void {
    const db = this.requireDb()
    const ftsFactsCount = (db.prepare('SELECT count(*) as c FROM fts_facts').get() as { c: number }).c
    if (ftsFactsCount === 0) {
      const factsCount = (db.prepare('SELECT count(*) as c FROM facts').get() as { c: number }).c
      if (factsCount > 0) {
        db.exec('INSERT INTO fts_facts(rowid, content, target) SELECT rowid, content, target FROM facts')
      }
    }
    const ftsCardsCount = (db.prepare('SELECT count(*) as c FROM fts_cards').get() as { c: number }).c
    if (ftsCardsCount === 0) {
      const cardsCount = (db.prepare('SELECT count(*) as c FROM knowledge_cards').get() as { c: number }).c
      if (cardsCount > 0) {
        db.exec('INSERT INTO fts_cards(rowid, title, summary, tags) SELECT rowid, title, summary, tags FROM knowledge_cards')
      }
    }
  }

  // ── Events ─────────────────────────────────────────────────────────────

  addEvent(input: { type: EventType, target?: string | null, payload?: unknown, sessionId?: string | null }): EventRecord {
    const db = this.requireDb()
    const record: EventRecord = {
      id: newId(),
      type: input.type,
      target: input.target ?? null,
      payload: JSON.stringify(input.payload ?? {}),
      sessionId: input.sessionId ?? null,
      createdAt: nowIso(),
    }
    db.prepare('INSERT INTO events(id, type, target, payload, sessionId, createdAt) VALUES(?, ?, ?, ?, ?, ?)')
      .run(record.id, record.type, record.target, record.payload, record.sessionId, record.createdAt)
    return record
  }

  listEvents(limit = 50): EventRecord[] {
    const db = this.requireDb()
    const rows = db.prepare('SELECT * FROM events ORDER BY createdAt DESC LIMIT ?').all(limit) as unknown as EventRecord[]
    return rows
  }

  countEvents(): number {
    const db = this.requireDb()
    return (db.prepare('SELECT count(*) as c FROM events').get() as { c: number }).c
  }

  // ── Candidates (pending review queue) ──────────────────────────────────

  createCandidate(input: { eventId: string, target: FactTarget, content: string, provenance?: string | null }): CandidateRecord {
    const db = this.requireDb()
    const content = input.content.trim()
    if (content === '') throw new Error('candidate content is empty')
    if (!isFactTarget(input.target)) throw new Error('invalid target')
    const record: CandidateRecord = {
      id: newId(),
      eventId: input.eventId,
      target: input.target,
      content,
      status: 'pending',
      provenance: input.provenance ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    db.prepare('INSERT INTO candidates(id, eventId, target, content, status, provenance, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.eventId, record.target, record.content, record.status, record.provenance, record.createdAt, record.updatedAt)
    this.audit({ origin: 'candidate', target: input.target, outcome: 'candidate-created', details: JSON.stringify({ candidateId: record.id }) })
    return record
  }

  listCandidates(status?: CandidateStatus): CandidateRecord[] {
    const db = this.requireDb()
    if (status === undefined) {
      return db.prepare('SELECT * FROM candidates ORDER BY createdAt ASC').all() as unknown as CandidateRecord[]
    }
    return db.prepare('SELECT * FROM candidates WHERE status=? ORDER BY createdAt ASC').all(status) as unknown as CandidateRecord[]
  }

  getCandidate(id: string): CandidateRecord | undefined {
    const db = this.requireDb()
    return db.prepare('SELECT * FROM candidates WHERE id=?').get(id) as unknown as CandidateRecord | undefined
  }

  approveCandidate(id: string): { candidate: CandidateRecord, fact: FactRecord } {
    const db = this.requireDb()
    const candidate = this.getCandidate(id)
    if (candidate === undefined) throw new Error(`candidate ${id} not found`)
    if (candidate.status !== 'pending') throw new Error(`candidate ${id} is not pending (status=${candidate.status})`)

    // Deduplicate: if fact already exists with same content+target, mark superseded
    const existing = db.prepare('SELECT * FROM facts WHERE target=? AND content=?').get(candidate.target, candidate.content) as unknown as FactRecord | undefined
    if (existing !== undefined) {
      db.prepare('UPDATE candidates SET status=?, updatedAt=? WHERE id=?').run('superseded', nowIso(), id)
      const updated = { ...candidate, status: 'superseded' as const, updatedAt: nowIso() }
      this.audit({ origin: 'candidate', target: candidate.target, outcome: 'candidate-superseded', details: JSON.stringify({ candidateId: id }) })
      return { candidate: updated, fact: existing }
    }

    // Budget check against character limit (fail fast, do not write)
    const total = this.factsCharCount(candidate.target) + candidate.content.length + 2 // delimiter
    const limit = candidate.target === 'user' ? this.options.userCharLimit : this.options.memoryCharLimit
    if (total > limit) {
      throw new Error(`approve would exceed ${candidate.target} budget ${String(total)}/${String(limit)}`)
    }

    const fact: FactRecord = {
      id: newId(),
      target: candidate.target,
      content: candidate.content,
      version: 1,
      provenanceEventId: candidate.eventId,
      provenanceCandidateId: candidate.id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }

    db.exec('BEGIN')
    try {
      db.prepare('INSERT INTO facts(id, target, content, version, provenanceEventId, provenanceCandidateId, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(fact.id, fact.target, fact.content, fact.version, fact.provenanceEventId, fact.provenanceCandidateId, fact.createdAt, fact.updatedAt)
      db.prepare('UPDATE candidates SET status=?, updatedAt=? WHERE id=?').run('approved', nowIso(), id)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }

    const updatedCandidate = { ...candidate, status: 'approved' as const, updatedAt: nowIso() }
    this.audit({ origin: 'candidate', target: candidate.target, outcome: 'candidate-approved', details: JSON.stringify({ candidateId: id, factId: fact.id }) })
    return { candidate: updatedCandidate, fact }
  }

  rejectCandidate(id: string, reason?: string): CandidateRecord {
    const db = this.requireDb()
    const candidate = this.getCandidate(id)
    if (candidate === undefined) throw new Error(`candidate ${id} not found`)
    if (candidate.status !== 'pending') throw new Error(`candidate ${id} is not pending`)
    db.prepare('UPDATE candidates SET status=?, updatedAt=? WHERE id=?').run('rejected', nowIso(), id)
    this.audit({ origin: 'candidate', target: candidate.target, outcome: 'candidate-rejected', details: JSON.stringify({ candidateId: id, reason: reason ?? '' }) })
    return { ...candidate, status: 'rejected', updatedAt: nowIso() }
  }

  // ── Facts (approved memory) ────────────────────────────────────────────

  listFacts(target?: FactTarget): FactRecord[] {
    const db = this.requireDb()
    if (target === undefined) {
      return db.prepare('SELECT * FROM facts ORDER BY updatedAt ASC').all() as unknown as FactRecord[]
    }
    return db.prepare('SELECT * FROM facts WHERE target=? ORDER BY updatedAt ASC').all(target) as unknown as FactRecord[]
  }

  factsCharCount(target: FactTarget): number {
    const facts = this.listFacts(target)
    if (facts.length === 0) return 0
    return facts.map(f => f.content).join('\n§\n').length
  }

  /** Direct upsert used by migration and by approved candidate flow; dedup + version bump. */
  upsertFact(input: { target: FactTarget, content: string, provenanceEventId?: string | null, provenanceCandidateId?: string | null }): FactRecord {
    const db = this.requireDb()
    const content = input.content.trim()
    if (content === '') throw new Error('fact content empty')
    if (!isFactTarget(input.target)) throw new Error('invalid target')
    const existing = db.prepare('SELECT * FROM facts WHERE target=? AND content=?').get(input.target, content) as unknown as FactRecord | undefined
    if (existing !== undefined) {
      db.prepare('UPDATE facts SET version=version+1, updatedAt=? WHERE id=?').run(nowIso(), existing.id)
      return { ...existing, version: existing.version + 1, updatedAt: nowIso() }
    }
    const fact: FactRecord = {
      id: newId(),
      target: input.target,
      content,
      version: 1,
      provenanceEventId: input.provenanceEventId ?? null,
      provenanceCandidateId: input.provenanceCandidateId ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    db.prepare('INSERT INTO facts(id, target, content, version, provenanceEventId, provenanceCandidateId, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fact.id, fact.target, fact.content, fact.version, fact.provenanceEventId, fact.provenanceCandidateId, fact.createdAt, fact.updatedAt)
    return fact
  }

  deleteFact(id: string): boolean {
    const db = this.requireDb()
    const result = db.prepare('DELETE FROM facts WHERE id=?').run(id)
    return (result as unknown as { changes: number }).changes > 0
  }

  /** Hybrid search: FTS5 for latin, LIKE/bigram fallback for CJK. */
  searchFacts(query: string, target?: FactTarget, limit = 8): FactRecord[] {
    const db = this.requireDb()
    const clean = query.trim()
    if (clean === '') return []
    const boundedLimit = Math.max(1, Math.min(limit, 20))
    // Try FTS5 first (good for latin). Use rank for ordering.
    try {
      const ftsQuery = toFtsQuery(clean)
      if (ftsQuery !== '') {
        const sql = target === undefined
          ? 'SELECT f.* FROM facts f JOIN fts_facts ft ON f.rowid=ft.rowid WHERE fts_facts MATCH ? ORDER BY rank LIMIT ?'
          : 'SELECT f.* FROM facts f JOIN fts_facts ft ON f.rowid=ft.rowid WHERE fts_facts MATCH ? AND f.target=? ORDER BY rank LIMIT ?'
        const params = target === undefined ? [ftsQuery, boundedLimit] : [ftsQuery, target, boundedLimit]
        const rows = db.prepare(sql).all(...params) as unknown as FactRecord[]
        if (rows.length > 0) return rows
      }
    } catch {
      // FTS parse error -> fall through to LIKE
    }
    // CJK / fallback: LIKE with bigram expansion
    const terms = tokenizeForLike(clean)
    if (terms.length === 0) return []
    const facts = this.listFacts(target)
    const scored: Array<{ fact: FactRecord, score: number }> = []
    for (const fact of facts) {
      const content = fact.content.toLocaleLowerCase()
      let score = 0
      for (const term of terms) {
        if (content.includes(term)) score += 1
      }
      if (score > 0) scored.push({ fact, score })
    }
    scored.sort((a, b) => b.score - a.score || a.fact.updatedAt.localeCompare(b.fact.updatedAt))
    return scored.slice(0, boundedLimit).map(s => s.fact)
  }

  // ── Knowledge cards (SQLite mirror of knowledge.json) ───────────────────

  listKnowledgeCards(): KnowledgeCardRecord[] {
    const db = this.requireDb()
    const rows = db.prepare('SELECT * FROM knowledge_cards ORDER BY updatedAt DESC').all() as Array<Omit<KnowledgeCardRecord, 'tags'> & { tags: string }>
    return rows.map(r => ({ ...r, tags: parseTagsJson(r.tags) }))
  }

  getKnowledgeCard(id: string): KnowledgeCardRecord | undefined {
    const db = this.requireDb()
    const row = db.prepare('SELECT * FROM knowledge_cards WHERE id=?').get(id) as (Omit<KnowledgeCardRecord, 'tags'> & { tags: string }) | undefined
    if (row === undefined) return undefined
    return { ...row, tags: parseTagsJson(row.tags) }
  }

  addKnowledgeCard(input: { title: string, summary: string, tags?: readonly string[], source?: KnowledgeSource }): KnowledgeCardRecord {
    const db = this.requireDb()
    const title = input.title.trim()
    const summary = input.summary.trim()
    if (title === '' || summary === '') throw new Error('title and summary required')
    const tags = normalizeTags(input.tags)
    const source = input.source ?? 'manual'
    const existing = db.prepare('SELECT * FROM knowledge_cards WHERE title=? COLLATE NOCASE').get(title) as unknown as KnowledgeCardRecord | undefined
    if (existing !== undefined) throw new Error(`card with title "${existing.title}" already exists`)

    const count = (db.prepare('SELECT count(*) as c FROM knowledge_cards').get() as { c: number }).c
    if (count >= this.options.maxCards) throw new Error(`knowledge store full (${String(this.options.maxCards)} cards)`)

    const record: KnowledgeCardRecord = {
      id: newId(),
      title,
      summary,
      tags,
      source,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    db.prepare('INSERT INTO knowledge_cards(id, title, summary, tags, source, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.title, record.summary, JSON.stringify(record.tags), record.source, record.createdAt, record.updatedAt)
    this.audit({ origin: 'knowledge', target: 'knowledge', outcome: 'card-added', details: JSON.stringify({ id: record.id, title }) })
    return { ...record, tags: [...record.tags] }
  }

  updateKnowledgeCard(id: string, input: { title: string, summary: string, tags?: readonly string[] }): KnowledgeCardRecord {
    const db = this.requireDb()
    const current = this.getKnowledgeCard(id)
    if (current === undefined) throw new Error(`no card ${id}`)
    const title = input.title.trim()
    const summary = input.summary.trim()
    if (title === '' || summary === '') throw new Error('title and summary required')
    const tags = normalizeTags(input.tags)
    const conflict = db.prepare('SELECT * FROM knowledge_cards WHERE id<>? AND title=? COLLATE NOCASE').get(id, title) as unknown as KnowledgeCardRecord | undefined
    if (conflict !== undefined) throw new Error(`another card already uses title "${conflict.title}"`)
    db.prepare('UPDATE knowledge_cards SET title=?, summary=?, tags=?, updatedAt=? WHERE id=?')
      .run(title, summary, JSON.stringify(tags), nowIso(), id)
    const updated = { ...current, title, summary, tags, updatedAt: nowIso() }
    this.audit({ origin: 'knowledge', target: 'knowledge', outcome: 'card-updated', details: JSON.stringify({ id }) })
    return updated
  }

  deleteKnowledgeCard(id: string): boolean {
    const db = this.requireDb()
    const result = db.prepare('DELETE FROM knowledge_cards WHERE id=?').run(id)
    const changed = (result as unknown as { changes: number }).changes > 0
    if (changed) this.audit({ origin: 'knowledge', target: 'knowledge', outcome: 'card-deleted', details: JSON.stringify({ id }) })
    return changed
  }

  searchKnowledgeCards(query: string, limit = 8): KnowledgeCardRecord[] {
    const db = this.requireDb()
    const clean = query.trim()
    if (clean === '') {
      return db.prepare('SELECT * FROM knowledge_cards ORDER BY updatedAt DESC LIMIT ?').all(Math.max(1, Math.min(limit, 20))) as unknown as KnowledgeCardRecord[]
    }
    const boundedLimit = Math.max(1, Math.min(limit, 20))
    try {
      const ftsQuery = toFtsQuery(clean)
      if (ftsQuery !== '') {
        const rows = db.prepare('SELECT k.* FROM knowledge_cards k JOIN fts_cards ft ON k.rowid=ft.rowid WHERE fts_cards MATCH ? ORDER BY rank LIMIT ?').all(ftsQuery, boundedLimit) as unknown as KnowledgeCardRecord[]
        if (rows.length > 0) return rows.map(r => ({ ...r, tags: JSON.parse(r.tags as unknown as string) as string[] }))
      }
    } catch {}
    // LIKE fallback with tag/title/summary boost
    const terms = tokenizeForLike(clean)
    const cards = this.listKnowledgeCards().map(c => ({ ...c, tags: typeof c.tags === 'string' ? JSON.parse(c.tags as unknown as string) as string[] : c.tags as unknown as string[] }))
    const scored: Array<{ card: KnowledgeCardRecord, score: number }> = []
    for (const card of cards) {
      const title = card.title.toLocaleLowerCase()
      const summary = card.summary.toLocaleLowerCase()
      const tags = card.tags.map(t => t.toLocaleLowerCase())
      let score = 0
      for (const term of terms) {
        if (tags.some(t => t.includes(term))) score += 4
        if (title.includes(term)) score += 2
        if (summary.includes(term)) score += 1
      }
      if (score > 0) scored.push({ card, score })
    }
    scored.sort((a, b) => b.score - a.score || a.card.updatedAt.localeCompare(b.card.updatedAt))
    return scored.slice(0, boundedLimit).map(s => s.card)
  }

  // ── Document chunks (S2 ready) ─────────────────────────────────────────

  upsertDocumentChunks(path: string, hash: string, chunks: readonly string[]): void {
    const db = this.requireDb()
    const now = nowIso()
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM document_chunks WHERE path=?').run(path)
      for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i]!
        if (content.trim() === '') continue
        db.prepare('INSERT INTO document_chunks(id, path, hash, chunkIndex, content, updatedAt) VALUES(?, ?, ?, ?, ?, ?)')
          .run(newId(), path, hash, i, content, now)
      }
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  getDocumentChunks(path: string): DocumentChunkRecord[] {
    const db = this.requireDb()
    return db.prepare('SELECT * FROM document_chunks WHERE path=? ORDER BY chunkIndex ASC').all(path) as unknown as DocumentChunkRecord[]
  }

  searchDocumentChunks(query: string, limit = 8): DocumentChunkRecord[] {
    const db = this.requireDb()
    const clean = query.trim()
    if (clean === '') return []
    const bounded = Math.max(1, Math.min(limit, 20))
    try {
      const ftsQuery = toFtsQuery(clean)
      if (ftsQuery !== '') {
        const rows = db.prepare('SELECT d.* FROM document_chunks d JOIN fts_chunks ft ON d.rowid=ft.rowid WHERE fts_chunks MATCH ? ORDER BY rank LIMIT ?').all(ftsQuery, bounded) as unknown as DocumentChunkRecord[]
        if (rows.length > 0) return rows
      }
    } catch {}
    return []
  }

  // ── Relations (graph edges, S2) ────────────────────────────────────────

  upsertRelation(sourceId: string, targetId: string, type: string, weight = 1.0): void {
    const db = this.requireDb()
    db.prepare('INSERT INTO relations(sourceId, targetId, type, weight) VALUES(?, ?, ?, ?) ON CONFLICT(sourceId, targetId, type) DO UPDATE SET weight=excluded.weight')
      .run(sourceId, targetId, type, weight)
  }

  listRelations(): RelationRecord[] {
    const db = this.requireDb()
    return db.prepare('SELECT * FROM relations').all() as unknown as RelationRecord[]
  }

  // ── Audit ───────────────────────────────────────────────────────────────

  audit(input: { origin: string, target: string, outcome: string, error?: string, details?: string }): void {
    const db = this.requireDb()
    const id = newId()
    db.prepare('INSERT INTO audit(id, time, origin, target, outcome, error, details) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(id, nowIso(), input.origin, input.target, input.outcome, input.error ?? null, input.details ?? null)
  }

  listAudit(limit = 50): Array<{ id: string, time: string, origin: string, target: string, outcome: string, error: string | null }> {
    const db = this.requireDb()
    return db.prepare('SELECT * FROM audit ORDER BY time DESC LIMIT ?').all(limit) as Array<{ id: string, time: string, origin: string, target: string, outcome: string, error: string | null }>
  }

  /** Write MEMORY.md / USER.md projections from approved facts (dual-write for compat). */
  async syncProjection(memoryDir: string): Promise<void> {
    const db = this.requireDb()
    for (const target of ['memory', 'user'] as const) {
      const facts = db.prepare('SELECT content FROM facts WHERE target=? ORDER BY updatedAt ASC').all(target) as Array<{ content: string }>
      const body = facts.map(f => f.content).join('\n§\n')
      const fileName = target === 'user' ? 'USER.md' : 'MEMORY.md'
      const filePath = join(memoryDir, fileName)
      await mkdir(memoryDir, { recursive: true })
      // Atomic-ish: write to tmp then rename (keep 0600).
      const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, body, { mode: 0o600 })
      try {
        await rename(tmp, filePath)
      } catch {
        await rm(tmp, { force: true }).catch(() => {})
        throw new Error(`failed to project ${fileName}`)
      }
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  stats(): { events: number, candidatesPending: number, facts: number, cards: number, chunks: number, relations: number } {
    const db = this.requireDb()
    return {
      events: (db.prepare('SELECT count(*) as c FROM events').get() as { c: number }).c,
      candidatesPending: (db.prepare("SELECT count(*) as c FROM candidates WHERE status='pending'").get() as { c: number }).c,
      facts: (db.prepare('SELECT count(*) as c FROM facts').get() as { c: number }).c,
      cards: (db.prepare('SELECT count(*) as c FROM knowledge_cards').get() as { c: number }).c,
      chunks: (db.prepare('SELECT count(*) as c FROM document_chunks').get() as { c: number }).c,
      relations: (db.prepare('SELECT count(*) as c FROM relations').get() as { c: number }).c,
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function normalizeTags(value: readonly string[] | undefined): string[] {
  const tags: string[] = []
  for (const raw of value ?? []) {
    const t = typeof raw === 'string' ? raw.trim().slice(0, 24) : ''
    if (t === '') continue
    if (!tags.includes(t)) tags.push(t)
    if (tags.length >= 8) break
  }
  return tags
}

/** Escape a user query into a safe FTS5 MATCH string (quoted terms, OR between). */
function toFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/u).filter(t => t !== '').slice(0, 8)
  if (terms.length === 0) return ''
  // Quote each term to avoid FTS syntax injection; drop terms with only FTS operators
  const quoted = terms.map(t => {
    const clean = t.replace(/["*]/g, '').trim()
    if (clean === '') return ''
    // For CJK single chars, FTS tokenisation is weak; skip to let LIKE handle
    if (/^[\u3400-\u9fff\uf900-\ufaff]$/u.test(clean)) return ''
    return `"${clean.replace(/"/g, '""')}"`
  }).filter(t => t !== '')
  if (quoted.length === 0) return ''
  return quoted.join(' OR ')
}

/** Tokenise for LIKE fallback: latin words plus CJK bigrams. */
function tokenizeForLike(query: string): string[] {
  const text = query.trim().toLocaleLowerCase()
  if (text === '') return []
  const terms = new Set<string>()
  for (const token of text.split(/\s+/u)) {
    if (token === '') continue
    if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(token)) {
      const chars = [...token]
      if (chars.length === 1) terms.add(token)
      else for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i]! + chars[i + 1]!)
    } else {
      terms.add(token)
    }
  }
  return [...terms]
}

function parseTagsJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string')
    return []
  } catch {
    return []
  }
}

/** Open path helper used by profile code. */
export function defaultUnifiedDbPath(profileDir: string): string {
  return join(profileDir, 'unified.db')
}

export function ensureUnifiedDb(profileDir: string, options: UnifiedDbOptions): UnifiedDb {
  const path = defaultUnifiedDbPath(profileDir)
  const db = new UnifiedDb(path, options)
  db.open()
  return db
}
