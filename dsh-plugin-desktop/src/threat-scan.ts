/**
 * Strict threat scanning for memory writes, ported from Hermes
 * `tools/threat_patterns.py` (strict scope). Pure and dependency-free so the
 * same function can guard both the write entry and the frozen snapshot.
 *
 * Policy: memory content is untrusted data that survives across sessions and
 * is injected into the system prompt, so it gets the strictest scan. A hit
 * blocks the write before it reaches disk; a hit discovered on load degrades
 * the snapshot entry to a `[BLOCKED: …]` placeholder while the live file
 * keeps the original text so the user can see and remove it.
 */

const MAX_SCAN_CHARS = 65_536

/** Canonical labels for reporting, in scan order. */
const PATTERN_LABELS = [
  'instruction-override',
  'prompt-exfiltration',
  'secret-exfiltration',
  'remote-command',
  'ssh-persistence',
  'hardcoded-credential',
  'invisible-unicode',
] as const

type PatternLabel = typeof PATTERN_LABELS[number]

interface ThreatPattern {
  readonly label: PatternLabel
  readonly source: RegExp
}

/**
 * Bounded lazy gaps between the anchor words of an injection phrase. The
 * bounds make worst-case matching time predictable without opening the
 * backtracking trap a free `.*` would create (same discipline as Hermes
 * threat_patterns.py:53-59).
 */
const GAP = String.raw`\b.{0,24}?`
const GAP_LONG = String.raw`\b.{0,64}?`

const THREAT_PATTERNS: readonly ThreatPattern[] = [
  {
    label: 'instruction-override',
    source: new RegExp(String.raw`ignore${GAP}(?:all|any)?${GAP}(?:previous|prior|above|earlier|original)${GAP}(?:instructions?|messages?|conversation|rules?)`, 'i'),
  },
  {
    label: 'instruction-override',
    source: new RegExp(String.raw`(?:disregard|forget|override|discard)${GAP}(?:your|the)?${GAP}(?:system\s*)?(?:prompt|instructions?|rules?)`, 'i'),
  },
  {
    label: 'prompt-exfiltration',
    source: new RegExp(String.raw`(?:reveal|print|output|repeat|show|leak)${GAP}(?:your|the)?${GAP}(?:system\s*prompt|base\s*prompt|developer\s*messages?|hidden\s*instructions?)`, 'i'),
  },
  {
    label: 'secret-exfiltration',
    source: new RegExp(String.raw`(?:exfiltrat\w*|steal|send|upload|post)${GAP_LONG}(?:credentials?|api[ _-]?keys?|secrets?|tokens?)${GAP_LONG}(?:to|via)`, 'i'),
  },
  {
    label: 'remote-command',
    source: new RegExp(String.raw`(?:curl|wget|nc|netcat|ncat)\b${GAP_LONG}(?:\|\s*(?:bash|sh|cmd|powershell)\b|/dev/tcp/)`, 'i'),
  },
  {
    label: 'ssh-persistence',
    source: new RegExp(String.raw`authorized_keys|ssh${GAP_LONG}(?:command=|\-oProxyCommand)`, 'i'),
  },
  {
    label: 'hardcoded-credential',
    source: /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|sk-[A-Za-z0-9]{24,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/,
  },
]

/** Unicode format-control run: U+200B..U+200F, U+2028/2029, U+202A..U+2069. */
// eslint-disable-next-line no-control-regex
const INVISIBLE_UNICODE = /[\u200B-\u200F\u2028\u2029\u202A-\u2069]/u

export interface ThreatScanResult {
  readonly blocked: boolean
  readonly reasons: readonly string[]
}

/**
 * Scan untrusted text with the strict memory scope. The scan runs against the
 * raw text first (invisible Unicode is detected BEFORE normalization, because
 * NFKC can erase some code points), then against its NFKC fold to defeat
 * full-width homoglyph bypasses (ｃａｔ → cat).
 */
export function scanThreats(text: string): ThreatScanResult {
  const raw = text.slice(0, MAX_SCAN_CHARS)
  const reasons: PatternLabel[] = []
  if (INVISIBLE_UNICODE.test(raw)) reasons.push('invisible-unicode')
  for (const pattern of THREAT_PATTERNS) {
    pattern.source.lastIndex = 0
    if (pattern.source.test(raw) && !reasons.includes(pattern.label)) reasons.push(pattern.label)
  }
  const folded = raw.normalize('NFKC')
  if (folded !== raw) {
    for (const pattern of THREAT_PATTERNS) {
      pattern.source.lastIndex = 0
      if (pattern.source.test(folded) && !reasons.includes(pattern.label)) reasons.push(pattern.label)
    }
  }
  return { blocked: reasons.length > 0, reasons }
}

/** Snapshot degradation for one on-disk entry; `null` when the entry is clean. */
export function blockedSnapshotEntry(entry: string): string | null {
  const scan = scanThreats(entry)
  if (!scan.blocked) return null
  return `[BLOCKED: memory entry contained threat pattern(s): ${scan.reasons.join(', ')}]`
}
