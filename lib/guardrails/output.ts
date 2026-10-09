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
  /**
   * Characters the parent asked for by name (issue #27). Rule 7 was retired on 2026-10-08,
   * so the scan no longer consults this; it stays so callers need not change.
   */
  requestedCharacters?: readonly string[]
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


/**
 * The franchise characters (from the blocklist's list) who take part in the text - acting,
 * speaking, or alongside the children. Not a violation since rule 7 was retired; it decides
 * whether a story carries the personal-use notice, requested or not.
 */
export function charactersTakingPart(raw: string, childNames: readonly string[] = []): string[] {
  const text = sanitizeStoryText(raw)
  // A child called Elsa or Ryder is the family's own child, not a borrowed character.
  const own = new Set(childNames.map((n) => n.trim().toLowerCase()))
  const found: string[] = []
  for (const name of blocklist.output.franchise_characters ?? []) {
    if (own.has(name.toLowerCase())) continue
    if (franchisePatterns(name).some((re) => re.test(text))) found.push(name)
  }
  return found
}

/** Rule 6: a private individual is a name plus an identifying detail. */
const PRIVATE_RELATION =
  /\b(?:my|his|her|their|our)\s+(?:ex-?(?:wife|husband|boyfriend|girlfriend)|neighbour|neighbor|classmate|babysitter|childminder|landlord|boss|colleague|step-?(?:mum|mom|dad))\b/iu
const CAPITALIZED_NAME = /\b(?:Mr|Mrs|Miss|Ms|Dr)\.?\s+\p{Lu}\p{Ll}+|\b\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+\b/u

/**
 * s4.2: "Every chapter ends with a sentence, not a cliffhanger marker ('…' or '!?')."
 *
 * Calibrated against the shark reference story, which ends a band A chapter with
 * "the whole ocean went **WHOOOOSH**..." - a transition, not dread. So an ellipsis after
 * an all-caps sound effect is exempt, and the violation it raises is `soft` in any case:
 * whether a trailing ellipsis is actually a dread cliffhanger is a judgement, and rule 3's
 * real cliffhangers ("it was right behind him") are caught by the hard phrase list.
 */
const CLIFFHANGER_END = /(?:\.\.\.|…|!\?|\?!)[*_"'\s]*$/
const SOUND_EFFECT_BEFORE_MARKER = /([\p{Lu}]{3,})[*_"'\s]*(?:\.\.\.|…|!\?|\?!)[*_"'\s]*$/u

/**
 * Rule 10, the two shapes the L4 reviewer missed inside whole stories on 2026-10-08 (it
 * catches both in an excerpt): a child touching a wild animal, and a secret kept from a
 * grown-up. Free, so it runs on every story; a hit is mended (rung 1), not rewritten.
 */
const WILD_ANIMAL =
  /\b(?:(?:whale |nurse |great white |tiger |hammerhead |reef )?sharks?|whales?|dolphins?|orcas?|octopus(?:es)?|octopi|stingrays?|manta(?: rays?)?|jellyfish|eels?|seals?|sea lions?|walrus(?:es)?|sea turtles?|turtles?|crocodiles?|alligators?|snakes?|pythons?|cobras?|lizards?|komodo dragons?|bears?|polar bears?|wolves|wolf|foxes|fox|lions?|tigers?|leopards?|cheetahs?|jaguars?|elephants?|rhinos?|hippos?|gorillas?|chimpanzees?|monkeys?|bats?|eagles?|owls?|deer|moose|bison|buffalo|kangaroos?|koalas?|wild animals?)\b/i
const TOUCH_VERB = /\b(?:touch(?:ed|es|ing)?|pat(?:s|ted|ting)?|strok(?:e|ed|es|ing)|pet(?:s|ted|ting)|hug(?:s|ged|ging)?|cuddl(?:e|ed|es|ing)|fed|feed(?:s|ing)?|r(?:ide|ides|iding|ode))\b(?!\s+(?:on|off|upon|down|back|by)\b)/gi
// "touch its skin": the animal's own body, said with "its" - not "the back of the boat".
const TOUCHED_PART = /^\s+its\s+(?:[\w-]+\s+){0,2}?(?:skin|fins?|back|head|nose|fur|shell|tail|tentacles?|trunk|horns?|belly|scales?)\b/i
// A toy, a pet or a picture is not a wild animal: "hugged her teddy bear", "fed his pet turtle".
const NOT_WILD = /\b(?:toy|teddy|stuffed|plush|cuddly|soft|pet|model|statue|picture|drawing|photo|robot|balloon|lego|puppet|cartoon|my|his|her|their|our|your)\b/i
const SECRET_FROM_GROWN_UPS =
  /\b(?:(?:don'?t|do not|never|won'?t|not) tell (?:mom|mum|mommy|mummy|dad|daddy|grandma|grandpa|your (?:mom|mum|dad|parents)|the grown-?ups|any grown-?ups|a grown-?up|the teacher)|(?:keep|kept|keeping) (?:it|this|that) (?:a )?secret from|(?:a |our )?secret from (?:mom|mum|dad|the grown-?ups|your parents))\b/i

function addRule10Hits(text: string, violations: OutputViolation[]): void {
  TOUCH_VERB.lastIndex = 0
  for (let m = TOUCH_VERB.exec(text); m; m = TOUCH_VERB.exec(text)) {
    // "Pat smiled at the dolphins": a capitalised Pat or Pet is a name.
    if (m[0] === 'Pat' || m[0] === 'Pet') continue
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40)
    const sentenceEnd = after.search(/[.!?]/)
    const object = sentenceEnd === -1 ? after : after.slice(0, sentenceEnd)
    const animalObject = WILD_ANIMAL.exec(object)
    // "touched the whale shark" - the animal is the object; "touch its skin" - a body part,
    // with a wild animal named in the last few sentences.
    const partObject = TOUCHED_PART.test(object) && WILD_ANIMAL.test(text.slice(Math.max(0, m.index - 300), m.index))
    const ownedOrToy = animalObject ? NOT_WILD.test(object.slice(0, animalObject.index)) : false
    if ((animalObject && animalObject.index <= 25 && !ownedOrToy) || partObject) {
      violations.push({ rule: 10, quote: quoteAround(text, m.index, m[0].length).slice(0, 400), severity: 'hard' })
      break
    }
  }
  const secret = SECRET_FROM_GROWN_UPS.exec(text)
  if (secret) {
    violations.push({ rule: 10, quote: quoteAround(text, secret.index, secret[0].length).slice(0, 400), severity: 'hard' })
  }
}

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
  addRule10Hits(text, violations)

  // Rule 7 was retired on 2026-10-08 (owner decision): a character from a film, game or
  // book taking part is no longer a violation. `charactersTakingPart` still finds them, so
  // the story can carry the personal-use notice.

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
    const text = chapter.text.trim()
    if (!CLIFFHANGER_END.test(text)) return
    if (SOUND_EFFECT_BEFORE_MARKER.test(text)) return
    failures.push({ check: 'cliffhanger_marker', detail: `chapter_${i + 1}` })
    violations.push({ rule: 3, quote: text.slice(-200), severity: 'soft' })
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

/**
 * s4.4 The True Facts list:
 *  - "Each item must map to a fact-pack `fact_id` marked `kid_safe: true` with
 *     `min_age <= youngest child`."
 *  - "No item may introduce a topic not in the story."
 *
 * Free and deterministic, and it is the guardrail half of F7's `unsourced_fact`,
 * `fact_not_kid_safe` and `fact_min_age` checks.
 */
export function checkTrueFacts(
  story: StoryOutput,
  facts: readonly { id: string; kid_safe: boolean; min_age: number }[],
  youngestAge: number,
): CheckFailure[] {
  const byId = new Map(facts.map((f) => [f.id, f]))
  const failures: CheckFailure[] = []
  for (const item of story.true_facts) {
    const fact = byId.get(item.fact_id)
    if (!fact) {
      failures.push({ check: 'unsourced_fact', detail: `unsourced_fact:${item.fact_id}` })
      continue
    }
    if (!fact.kid_safe) {
      failures.push({ check: 'fact_not_kid_safe', detail: `fact_not_kid_safe:${item.fact_id}` })
    }
    if (fact.min_age > youngestAge) {
      failures.push({
        check: 'fact_min_age',
        detail: `fact_min_age:${item.fact_id}:${fact.min_age}>${youngestAge}`,
      })
    }
  }
  return failures
}

/** The rule numbers the deterministic layer can detect at all. Reported, not asserted. */
export function deterministicallyCoveredRules(): number[] {
  const rules = new Set<number>([6, 14, 3, 10])
  for (const g of blocklist.output.hard_phrases) rules.add(g.rule)
  return [...rules].sort((a, b) => a - b)
}
