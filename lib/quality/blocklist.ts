import outputBlocklist from '@/config/guardrails/output-blocklist.json'

/**
 * Blocklist matcher for finished stories (GUARDRAILS.md §4.2).
 *
 * Two rules make it usable:
 *  - **word boundaries**, so "Scunthorpe" and "begun" never match a term;
 *  - an **allowlist of phrases**, so a legitimate use inside a known phrase ("killer
 *    whale", "dead end", "a tiny drop of blood") is not a hit.
 *
 * Lane 6's input blocklist can be passed in as `extra` so the story is scanned against
 * "the same list as input plus a story-specific list" without this module owning theirs.
 */

export interface BlocklistData {
  terms: readonly string[]
  phrases: readonly string[]
  allow: readonly string[]
}

export const OUTPUT_BLOCKLIST: BlocklistData = outputBlocklist as unknown as BlocklistData

export interface BlocklistHit {
  /** The term or phrase that matched, lower-cased as it appears in the list. */
  match: string
  kind: 'term' | 'phrase'
  index: number
  /** A little context, for the failure detail. Never shown to the parent. */
  context: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Ranges covered by an allowlisted phrase. A hit inside one of these is not a hit. */
function allowedRanges(text: string, allow: readonly string[]): [number, number][] {
  const ranges: [number, number][] = []
  for (const phrase of allow) {
    const re = new RegExp(escapeRegExp(phrase).replace(/\\?\s+/g, '\\s+'), 'gi')
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue
      ranges.push([m.index, m.index + m[0].length])
    }
  }
  return ranges
}

function isAllowed(index: number, length: number, ranges: readonly [number, number][]): boolean {
  return ranges.some(([start, end]) => index >= start && index + length <= end)
}

function contextAround(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 30)
  const to = Math.min(text.length, index + length + 30)
  return text.slice(from, to).replace(/\s+/g, ' ').trim()
}

export function scanBlocklist(
  text: string,
  lists: readonly BlocklistData[] = [OUTPUT_BLOCKLIST],
): BlocklistHit[] {
  const terms = new Set<string>()
  const phrases = new Set<string>()
  const allow = new Set<string>()
  for (const list of lists) {
    for (const t of list.terms ?? []) terms.add(t.toLowerCase())
    for (const p of list.phrases ?? []) phrases.add(p.toLowerCase())
    for (const a of list.allow ?? []) allow.add(a.toLowerCase())
  }

  const ranges = allowedRanges(text, [...allow])
  const hits: BlocklistHit[] = []
  const seen = new Set<string>()

  const record = (match: string, kind: 'term' | 'phrase', index: number, length: number): void => {
    if (isAllowed(index, length, ranges)) return
    const key = `${kind}:${match}`
    if (seen.has(key)) return
    seen.add(key)
    hits.push({ match, kind, index, context: contextAround(text, index, length) })
  }

  for (const term of terms) {
    // \b is wrong for terms containing an apostrophe or hyphen; build the guard manually.
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'giu')
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue
      record(term, 'term', m.index, m[0].length)
    }
  }

  for (const phrase of phrases) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(phrase).replace(/\\?\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`,
      'giu',
    )
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue
      record(phrase, 'phrase', m.index, m[0].length)
    }
  }

  return hits.sort((a, b) => a.index - b.index)
}

/** GUARDRAILS.md §4.2: no URLs, emails or phone numbers in a story. */
export const CONTACT_PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: 'url', pattern: /\b(?:https?:\/\/|www\.)\S+/i },
  { kind: 'url', pattern: /\b[a-z0-9-]+\.(?:com|net|org|io|co\.uk|gov|edu)\b/i },
  { kind: 'email', pattern: /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i },
  { kind: 'phone', pattern: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3,4}[\s-]\d{3,4}\b/ },
]

export function findContactInfo(text: string): { kind: string; match: string } | null {
  for (const { kind, pattern } of CONTACT_PATTERNS) {
    const m = pattern.exec(text)
    if (m) return { kind, match: m[0] }
  }
  return null
}
