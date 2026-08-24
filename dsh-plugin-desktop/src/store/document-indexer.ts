/**
 * Document indexer for S2: file -> chunks -> unified DB.
 * Chunking is deterministic, hash-based incremental, and bounded.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, extname, relative, resolve, isAbsolute } from 'node:path'
import { realpathSync } from 'node:fs'
import type { UnifiedDb } from './unified-db.ts'

const SUPPORTED_EXTS = new Set(['.md', '.mdx', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx'])
const MAX_FILE_BYTES = 512 * 1024 // 512 KiB per file cap
const CHUNK_CHARS = 800
const CHUNK_OVERLAP = 100

export interface IndexResult {
  readonly path: string
  readonly hash: string
  readonly chunks: number
  readonly updated: boolean
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * Naive semantic chunking: split by paragraph / line, then pack into
 * ~CHUNK_CHARS with CHUNK_OVERLAP. Keeps headings with following paragraph
 * for neighbourhood reading (WeKnora idea).
 */
export function chunkText(text: string, chunkChars = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized === '') return []
  if (normalized.length <= chunkChars) return [normalized]

  const paragraphs = normalized.split(/\n{2,}/u)
  const chunks: string[] = []
  let current = ''
  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (trimmed === '') continue
    if (current === '') {
      current = trimmed
      continue
    }
    if (current.length + 2 + trimmed.length <= chunkChars) {
      current = `${current}\n\n${trimmed}`
    } else {
      chunks.push(current)
      // overlap: tail of current + next para head
      const tail = current.slice(-overlap)
      current = tail.length > 0 ? `${tail}\n\n${trimmed}`.slice(-chunkChars) : trimmed
      // If single para exceeds chunk, split hard
      if (current.length > chunkChars) {
        for (let i = 0; i < current.length; i += chunkChars - overlap) {
          chunks.push(current.slice(i, i + chunkChars))
        }
        current = ''
      }
    }
  }
  if (current !== '') chunks.push(current)
  // Hard split any remaining oversize chunks
  const final: string[] = []
  for (const c of chunks) {
    if (c.length <= chunkChars) final.push(c)
    else for (let i = 0; i < c.length; i += chunkChars - overlap) final.push(c.slice(i, i + chunkChars))
  }
  return final
}

function isSupportedFile(path: string): boolean {
  return SUPPORTED_EXTS.has(extname(path).toLowerCase())
}

function isSafePath(base: string, target: string): boolean {
  try {
    const realBase = realpathSync(base)
    const realTarget = realpathSync(target)
    const rel = relative(realBase, realTarget)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    // If target does not exist yet, check resolved relative
    const resolvedBase = resolve(base)
    const resolvedTarget = resolve(target)
    const rel = relative(resolvedBase, resolvedTarget)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }
}

/**
 * Index one file into unified DB. Returns whether it was updated (hash changed).
 * Throws on unreadable files; caller decides to skip.
 */
export async function indexFile(db: UnifiedDb, filePath: string, baseDir: string): Promise<IndexResult> {
  const absolute = resolve(baseDir, filePath)
  if (!isSafePath(baseDir, absolute) && filePath !== absolute) {
    throw new Error(`unsafe path: ${filePath}`)
  }
  const st = await stat(absolute)
  if (!st.isFile()) throw new Error(`not a file: ${filePath}`)
  if (st.size > MAX_FILE_BYTES) throw new Error(`file too large: ${filePath} (${String(st.size)} bytes)`)

  const raw = await readFile(absolute)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new Error(`not utf8: ${filePath}`)
  }
  const hash = hashOf(text)
  const existing = db.getDocumentChunks(absolute)
  if (existing.length > 0 && existing[0]?.hash === hash) {
    return { path: absolute, hash, chunks: existing.length, updated: false }
  }
  const chunks = chunkText(text)
  db.upsertDocumentChunks(absolute, hash, chunks)
  return { path: absolute, hash, chunks: chunks.length, updated: true }
}

/**
 * Walk a directory recursively and index supported files. Bounded by file count
 * and total bytes to avoid runaway indexing.
 */
export async function indexDirectory(db: UnifiedDb, dir: string, options: { maxFiles?: number, recursive?: boolean } = {}): Promise<{ indexed: number, skipped: number, errors: string[] }> {
  const maxFiles = options.maxFiles ?? 200
  const recursive = options.recursive ?? true
  const errors: string[] = []
  let indexed = 0
  let skipped = 0

  async function walk(current: string): Promise<void> {
    if (indexed >= maxFiles) return
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch (error) {
      errors.push(String(error))
      return
    }
    for (const entry of entries) {
      if (indexed >= maxFiles) break
      if (entry.startsWith('.') || entry === 'node_modules' || entry === '.git') continue
      const full = join(current, entry)
      let st: Awaited<ReturnType<typeof stat>>
      try {
        st = await stat(full)
      } catch {
        skipped++
        continue
      }
      if (st.isDirectory() && recursive) {
        await walk(full)
      } else if (st.isFile() && isSupportedFile(full)) {
        try {
          const result = await indexFile(db, full, dir)
          if (result.updated) indexed++
          else skipped++
        } catch (error) {
          errors.push(`${full}: ${String(error)}`)
          skipped++
        }
      } else {
        skipped++
      }
    }
  }

  const resolved = resolve(dir)
  await walk(resolved)
  return { indexed, skipped, errors: errors.slice(0, 10) }
}

/** Knowledge page projection: group cards by shared tags / title prefix. */
export interface KnowledgePage {
  readonly id: string
  readonly title: string
  readonly cardIds: readonly string[]
  readonly tags: readonly string[]
}

export function buildKnowledgePages(cards: Array<{ id: string, title: string, tags: readonly string[] }>): KnowledgePage[] {
  const tagMap = new Map<string, string[]>()
  for (const card of cards) {
    for (const tag of card.tags) {
      const list = tagMap.get(tag) ?? []
      list.push(card.id)
      tagMap.set(tag, list)
    }
  }
  const pages: KnowledgePage[] = []
  for (const [tag, ids] of tagMap) {
    if (ids.length < 2) continue // only groups
    pages.push({ id: `tag:${tag}`, title: `主题：${tag}`, cardIds: ids, tags: [tag] })
  }
  // Fallback: if no tag groups, make one page per card (so UI never empty)
  if (pages.length === 0 && cards.length > 0) {
    for (const card of cards.slice(0, 5)) {
      pages.push({ id: `card:${card.id}`, title: card.title, cardIds: [card.id], tags: [...card.tags] })
    }
  }
  return pages.slice(0, 20)
}

/** Relation graph edges derived from shared tags (weight = shared tag count). */
export function buildRelations(cards: Array<{ id: string, tags: readonly string[] }>): Array<{ sourceId: string, targetId: string, type: string, weight: number }> {
  const edges: Array<{ sourceId: string, targetId: string, type: string, weight: number }> = []
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]!
      const b = cards[j]!
      const shared = a.tags.filter(t => b.tags.includes(t))
      if (shared.length > 0) {
        edges.push({ sourceId: a.id, targetId: b.id, type: 'shared-tag', weight: shared.length })
        edges.push({ sourceId: b.id, targetId: a.id, type: 'shared-tag', weight: shared.length })
      }
    }
  }
  return edges
}
