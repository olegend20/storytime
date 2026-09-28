import type { CheckFailure } from '@/lib/schemas/quality'
import type { OutputViolation } from '@/lib/schemas/guardrail'
import type { StoryOutput } from '@/lib/schemas/story'
import { storyText } from '@/lib/schemas/story'
import { blocklist, maskAllowed, plainPhrasePattern } from './blocklist'
import { matchPii } from './patterns'
import { sanitizeStoryText } from './sanitize'

/**
 * L4, first half - the free deterministic output checks. GUARDRAILS.md s4.2, run before
 * the Haiku safety review so a clear breach never costs a model call (s1.2).
 *
 * Two calibration constraints shaped this file, both from the reference stories:
 *
 *  - "They can smell a tiny drop of blood from very far away" (band A, shark story) and
 *    "people who liked shooting things" (band C, video games) are both fine. So the HARD
 *    patterns are violent *phrases* in context, never bare emotive words.
 *  - "Mario started life as Jumpman" is a permitted factual mention (rule 7), while
 *    "Mario waved at them" is not. So rule 7 looks for the character acting or
 *    accompanying the children, not for the name.
 *
 * Bare words from s4.2's list ("blood", "gun", "kill", "kiss") are still scanned, as
 * `soft` violations: they never fail a story on their own, and they are handed to the
 * Haiku review as things to look at. test/unit/guardrail-references.test.ts asserts all
 * four reference stories come through with zero hard violations.
 */

export interface OutputScanContext {
  /** Names of the selected children, for rules 13 and the structural checks. */
  childNames?: string[]
  /** Extra allowlisted phrases for this topic, e.g. "blood cells" for a biology story. */
  extraAllowed?: string[]
}

export interface OutputScanResult {
  violations: OutputViolation[]
  failures: CheckFailure[]
  get hardViolations(): OutputViolation[]
}

const QUOTE_RADIUS = 60

function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - QUOTE_RADIUS)
  const end = Math.min(text.length, index + length + QUOTE_RADIUS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/** A character acting or accompanying the children - rule 7's real signature. */
const PARTICIPATION_VERBS =
  '(?:said|says|shouted|whispered|replied|asked|answered|called out|laughed|giggled|grinned|smiled|waved|winked|nodded|hugged|cheered|helped|handed|joined|appeared|arrived|turned up|led the way|showed them|taught them|took his hand|took her hand|high-fived)'
const ACCOMPANY_PREFIX = '(?:with|alongside|beside|next to|joined by|together with|and then came)'

function franchisePatterns(name: string): RegExp[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [
    // "Elsa waved at them", "Pikachu helped"
    new RegExp(`(?<![\\p{L}])${escaped}\\s+${PARTICIPATION_VERBS}\\b`, 'iu'),
    // "said Elsa", "shouted Pikachu"
    new RegExp(`\\b${PARTICIPATION_VERBS}\\s+${escaped}(?![\\p{L}])`, 'iu'),
    // "with Elsa", "alongside Sonic"
    new RegExp(`\\b${ACCOMPANY_PREFIX}\\s+${escaped}(?![\\p{L}])`, 'iu'),
  ]
}

/** Rule 6: a private individual is a name plus an identifying detail. */
const PRIVATE_RELATION =
  /\b(?:my|his|her|their|our)\s+(?:ex-?(?:wife|husband|boyfriend|girlfriend)|neighbour|neighbor|classmate|babysitter|childminder|landlord|boss|colleague|step-?(?:mum|mom|dad))\b/iu
const CAPITALIZED_NAME = /\b(?:Mr|Mrs|Miss|Ms|Dr)\.?\s+\p{Lu}\p{Ll}+|\b\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+\b/u

/** s4.2: "Every chapter ends with a sentence, not a cliffhanger marker." */
const CLIFFHANGER_END = /(?:\.\.\.|…|!\?|\?!)\s*$/

const META_TOKENS = /\b(?:as an ai|as a language model|system prompt|my instructions were|ignore previous instructions)\b/i

function addPhraseHits(
  masked: string,
  original: string,
  violations: OutputViolation[],
): void {
  for (const group of blocklist.output.hard_phrases) {
    for (const phrase of group.phrases) {
      const re = plainPhrasePattern(phrase)
      re.lastIndex = 0
      const m = re.exec(masked)
      if (m) {
        violations.push({
          rule: group.rule,
          quote: quoteAround(original, m.index, m[0].length).slice(0, 400),
          severity: 'hard',
        })
        break // one violation per rule group is enough to fail the story
      }
    }
  }
}

function addSoftHits(masked: string, original: string, violations: OutputViolation[]): void {
  for (const group of blocklist.output.soft_terms) {
    for (const term of group.terms) {
      const re = plainPhrasePattern(term)
      re.lastIndex = 0
      const m = re.exec(masked)
      if (m) {
        violations.push({
          rule: group.rule,
          quote: quoteAround(original, m.index, m[0].length).slice(0, 400),
          severity: 'soft',
        })
        break
      }
    }
  }
}

/**
 * Scan a piece of story prose - a full story or a single excerpt. Excerpt-level scanning
 * is what `outputs_violations.json` exercises (s6).
 */
export function scanStoryText(raw: string, context: OutputScanContext = {}): OutputScanResult {
  const text = sanitizeStoryText(raw)
  const lower = text.toLowerCase()
  const allowed = [
    ...blocklist.output.allow_phrases,
    ...blocklist.allow_phrases,
    ...(context.extraAllowed ?? []),
  ]
  const masked = maskAllowed(lower, allowed)

  const violations: OutputViolation[] = []
  const failures: CheckFailure[] = []

  addPhraseHits(masked, text, violations)

  // Rule 7 - a branded character taking part.
  for (const name of blocklist.output.franchise_characters ?? []) {
    let matched = false
    for (const re of franchisePatterns(name)) {
      const m = re.exec(text)
      if (m) {
        violations.push({
          rule: 7,
          quote: quoteAround(text, m.index, m[0].length).slice(0, 400),
          severity: 'hard',
        })
        matched = true
        break
      }
    }
    if (matched) break
  }

  // Rule 6 - a private individual: relationship word plus a name.
  const relation = PRIVATE_RELATION.exec(text)
  if (relation) {
    const window = text.slice(relation.index, relation.index + relation[0].length + 40)
    if (CAPITALIZED_NAME.test(window.slice(relation[0].length))) {
      violations.push({
        rule: 6,
        quote: quoteAround(text, relation.index, relation[0].length).slice(0, 400),
        severity: 'hard',
      })
    }
  }

  // s4.2 - no URLs, emails or phone numbers in a story. Contact details for a named
  // person are also rule 6.
  const pii = matchPii(text)
  if (pii) {
    failures.push({ check: 'contains_url_or_contact', detail: `output_pii:${pii.id}` })
    if (pii.id === 'phone' || pii.id === 'email' || pii.id === 'street_address' || pii.id === 'uk_postcode') {
      violations.push({
        rule: 6,
        quote: quoteAround(text, text.indexOf(pii.match), pii.match.length).slice(0, 400),
        severity: 'hard',
      })
    }
  }

  // s4.2 - instruction / meta tokens. Rule 12.
  const meta = META_TOKENS.exec(text)
  if (meta) {
    failures.push({ check: 'meta_content', detail: `meta:${meta[0].toLowerCase()}` })
  }

  addSoftHits(masked, text, violations)

  return {
    violations,
    failures,
    get hardViolations() {
      return violations.filter((v) => v.severity === 'hard')
    },
  }
}

export interface StoryStructureContext extends OutputScanContext {
  /** Every selected child must appear; no other child name may be introduced (s4.2). */
  childNames: string[]
  /** Other child names known to the family, to catch an invented sibling. */
  knownOtherNames?: string[]
}

/**
 * The structural half of s4.2, which needs the parsed story rather than prose:
 * cliffhanger chapter endings, the children's names, and a present ending line.
 */
export function scanStoryStructure(
  story: StoryOutput,
  context: StoryStructureContext,
): OutputScanResult {
  const prose = scanStoryText(storyText(story), context)
  const violations = [...prose.violations]
  const failures = [...prose.failures]

  story.chapters.forEach((chapter, i) => {
    if (CLIFFHANGER_END.test(chapter.text.trim())) {
      failures.push({ check: 'cliffhanger_marker', detail: `chapter_${i + 1}` })
      violations.push({
        rule: 3,
        quote: chapter.text.trim().slice(-200),
        severity: 'hard',
      })
    }
  })

  const haystack = storyText(story).toLowerCase()
  for (const name of context.childNames) {
    if (!haystack.includes(name.toLowerCase())) {
      failures.push({ check: 'child_missing', detail: `child_missing:${name}` })
    }
  }
  for (const other of context.knownOtherNames ?? []) {
    if (
      !context.childNames.some((n) => n.toLowerCase() === other.toLowerCase()) &&
      haystack.includes(other.toLowerCase())
    ) {
      failures.push({ check: 'unknown_child_name', detail: `unknown_child_name:${other}` })
    }
  }

  if (story.ending_line.trim() === '') {
    failures.push({ check: 'ending_line_present', detail: 'ending_line_empty' })
    violations.push({ rule: 14, quote: '', severity: 'hard' })
  }

  return {
    violations,
    failures,
    get hardViolations() {
      return violations.filter((v) => v.severity === 'hard')
    },
  }
}

/** The rule numbers the deterministic layer can detect at all. Reported, not asserted. */
export function deterministicallyCoveredRules(): number[] {
  const rules = new Set<number>([6, 7, 14, 3])
  for (const g of blocklist.output.hard_phrases) rules.add(g.rule)
  return [...rules].sort((a, b) => a - b)
}
