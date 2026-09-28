import blocklistJson from '@/config/guardrails/blocklist.json'
import type { GuardrailCategory } from '@/lib/schemas/guardrail'

/**
 * The L1 hard blocklist matcher - GUARDRAILS.md s3.2:
 * "word-boundary matching and a small allowlist for false positives such as
 *  'shooting star', 'cocktail sausage', 'Scunthorpe'-style substrings".
 *
 * Two properties matter equally and pull in opposite directions:
 *
 *  1. Obfuscation must not work. "b o m b", "b.o.m.b", "b0mb", "bommb" and "ｂｏｍｂ"
 *     are all the same request.
 *  2. Innocent words must not be refused. "Scunthorpe", "Cockermouth", "analysis",
 *     "grapes" and "raccoon" all contain a blocklisted substring.
 *
 * Substring matching gets (1) and fails (2); plain \b matching gets (2) and fails (1).
 * So each term is compiled into a guarded pattern: a letter-boundary lookaround at each
 * end (never a substring match), each letter allowed to repeat, its common leetspeak
 * homoglyphs accepted, and - for terms of 4+ letters only - up to two separator
 * characters tolerated between letters. Every match must contain a real letter, so a
 * digits-only string can never trip a leet variant.
 */

export interface BlocklistConfig {
  updated_at: string
  version: number
  input_terms: Record<string, string[]>
  input_phrases: Record<string, string[]>
  allow_phrases: string[]
  output: {
    hard_phrases: { rule: number; id: string; phrases: string[] }[]
    soft_terms: { rule: number; terms: string[] }[]
    allow_phrases: string[]
    /** Rule 7 - branded characters, flagged only when they take part. */
    franchise_characters: string[]
  }
}

export const blocklist = blocklistJson as unknown as BlocklistConfig

/** Categories used by the blocklist, all members of the s3.3 enum. */
const CATEGORY_ORDER: GuardrailCategory[] = [
  'weapons_instructions',
  'self_harm',
  'sexual',
  'hate_extremism',
  'violence_graphic',
  'drugs_alcohol',
  'real_private_person',
  'off_mission',
]

/** Leetspeak and homoglyph substitutions seen in real evasion attempts. */
const HOMOGLYPHS: Record<string, string[]> = {
  a: ['4', '@'],
  b: ['8'],
  c: ['('],
  e: ['3'],
  g: ['9'],
  i: ['1', '!', '|'],
  l: ['1', '|'],
  o: ['0'],
  s: ['5', '$'],
  t: ['7', '+'],
  z: ['2'],
}

/** Characters an evader puts between letters. Deliberately not all of \W. */
const SEPARATOR = "[\\s._\\-*+~|/\\\\'\"`^,:;!?()\\[\\]{}]"

/** Terms shorter than this get no separator tolerance - "a s s" is too cheap to match. */
const MIN_LENGTH_FOR_SEPARATORS = 4

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function charClass(ch: string): string {
  const lower = ch.toLowerCase()
  const variants = HOMOGLYPHS[lower]
  if (!variants) return escapeRegex(ch)
  return `[${escapeRegex(lower)}${variants.map(escapeRegex).join('')}]`
}

/**
 * Compile one term into its guarded, obfuscation-tolerant pattern.
 * A term may itself be multi-word ("white power"); an inter-word space becomes a
 * required-but-flexible separator run rather than a literal space.
 */
export function compileTerm(term: string): RegExp {
  const letters = [...term.toLowerCase()]
  const tolerateSeparators = term.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_LENGTH_FOR_SEPARATORS
  const between = tolerateSeparators ? `${SEPARATOR}{0,2}` : ''

  const parts: string[] = []
  for (let i = 0; i < letters.length; i += 1) {
    const ch = letters[i] as string
    if (/\s/.test(ch)) {
      // Word gap inside a multi-word term: one or more separators, or nothing at all
      // ("white power" / "white-power" / "whitepower").
      parts.push(`${SEPARATOR}{0,3}`)
      continue
    }
    if (ch === '-') {
      // A hyphen in the term itself is optional ("e-cigarette" / "ecigarette").
      parts.push(`${SEPARATOR}{0,2}`)
      continue
    }
    parts.push(`${charClass(ch)}+`)
    const next = letters[i + 1]
    if (next !== undefined && !/[\s-]/.test(next)) parts.push(between)
  }

  // Letter/digit lookarounds rather than \b: the leet variants include non-word
  // characters ($, @, |), where \b flips meaning and stops protecting Scunthorpe.
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('')}(?![\\p{L}\\p{N}])`, 'giu')
}

const termCache = new Map<string, RegExp>()
function termPattern(term: string): RegExp {
  let re = termCache.get(term)
  if (!re) {
    re = compileTerm(term)
    termCache.set(term, re)
  }
  return re
}

/** A plain word-boundary phrase pattern - used for generated story text (s4.2). */
const plainCache = new Map<string, RegExp>()
export function plainPhrasePattern(phrase: string): RegExp {
  let re = plainCache.get(phrase)
  if (!re) {
    const body = escapeRegex(phrase.toLowerCase()).replace(/\\?\s+/g, '\\s+')
    re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu')
    plainCache.set(phrase, re)
    return re
  }
  return re
}

/**
 * Blank out every allowlisted phrase before matching, so "shooting star" cannot be
 * reached by a "shoot..." pattern while "shoot him" still is. Replaced with '.'
 * characters: same length (offsets stay usable) and not a letter, so a masked region
 * can never join two halves of a word into a new match.
 */
export function maskAllowed(text: string, allowPhrases: readonly string[]): string {
  let masked = text
  for (const phrase of allowPhrases) {
    masked = masked.replace(plainPhrasePattern(phrase), (m) => '.'.repeat(m.length))
  }
  return masked
}

export interface BlocklistHit {
  category: GuardrailCategory
  /** The list entry that matched - internal only, never shown to a parent (s5). */
  term: string
  /** What the text actually contained. Internal only. */
  match: string
  kind: 'term' | 'phrase'
}

/** Every match must contain at least one real letter (kills "4 55" -> "ass"). */
function hasLetter(s: string): boolean {
  return /\p{L}/u.test(s)
}

function firstHit(
  haystack: string,
  entries: readonly string[],
  category: GuardrailCategory,
  kind: 'term' | 'phrase',
): BlocklistHit | null {
  for (const entry of entries) {
    const re = kind === 'term' ? termPattern(entry) : plainPhrasePattern(entry)
    re.lastIndex = 0
    const m = re.exec(haystack)
    if (m && hasLetter(m[0])) return { category, term: entry, match: m[0], kind }
  }
  return null
}

/**
 * Scan one sanitized field value. Returns the first hit, or null.
 * Phrases are checked before single terms so the more specific category wins
 * ("how to pick a lock" is weapons_instructions, not a bare-term match).
 */
export function scanInput(text: string): BlocklistHit | null {
  const masked = maskAllowed(text.toLowerCase(), blocklist.allow_phrases)

  for (const category of CATEGORY_ORDER) {
    const phrases = blocklist.input_phrases[category]
    if (phrases) {
      const hit = firstHit(masked, phrases, category, 'phrase')
      if (hit) return hit
    }
  }
  for (const category of CATEGORY_ORDER) {
    const terms = blocklist.input_terms[category]
    if (terms) {
      const hit = firstHit(masked, terms, category, 'term')
      if (hit) return hit
    }
  }
  return null
}

/** Convenience for tests and for the story scan: is this phrase allowlisted here? */
export function isAllowlisted(text: string, extraAllowed: readonly string[] = []): boolean {
  const all = [...blocklist.allow_phrases, ...extraAllowed]
  return maskAllowed(text.toLowerCase(), all).replace(/\./g, '').trim() === ''
}
