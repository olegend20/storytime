import {
  MAX_CHAPTER_WORD_SHARE,
  MIN_CHILD_CHAPTER_COVERAGE,
  STORY_MAX_TRUE_FACTS,
  STORY_MIN_TRUE_FACTS,
  StoryOutput,
  countWords,
  storyText,
  storyWordCount,
  wordCountWithinTolerance,
  type AgeBand,
  type CheckFailure,
  type FactPack,
  type LengthMinutes,
} from '@/lib/schemas'
import { sentenceLengthFailure, sentenceStats, type SentenceStats } from '@/lib/bands'
import { OUTPUT_BLOCKLIST, findContactInfo, scanBlocklist, type BlocklistData } from './blocklist'
import { factTermsMissingFromStory } from './facts-in-story'
import { hasChildAction } from './actions'

/**
 * Deterministic output checks (F7). These run FIRST and are FREE; a failure here skips the
 * model review entirely (F7 AC), which is also GUARDRAILS.md §1.2 - cheap layers first.
 *
 * Every failure carries a stable `check` code from the DeterministicCheck enum plus a
 * `detail` string the VTs match on (`child_missing:Phoenix`). Reason codes are the
 * contract; the prose is not.
 */

export interface GateInput {
  /** The parsed story, or the raw unvalidated object when parsing is what we are checking. */
  story: unknown
  children: readonly { name: string; age: number }[]
  band: AgeBand
  minutes: LengthMinutes
  targetWords: { min: number; max: number }
  /**
   * The pack the story was written from. When null, the three fact-mapping checks are
   * SKIPPED and that is reported in `skipped` - the reference stories predate fact packs
   * and have synthetic ids (DECISIONS.md #22), so pretending to check them would test
   * nothing.
   */
  factPack: FactPack | null
  /** Lane 6's input blocklist, scanned alongside the story-specific one. */
  extraBlocklists?: readonly BlocklistData[]
}

export interface DeterministicResult {
  passed: boolean
  failures: CheckFailure[]
  /** Checks that could not run, with the reason. Never silently dropped. */
  skipped: string[]
  wordCount: number
  /** Chapter coverage per child name, for diagnostics. */
  coverage: Record<string, number>
  /** Measured sentence lengths, handed to the reviewer so it does not have to guess. */
  sentences: SentenceStats | null
}

const SIBLING_INTRO =
  /\b(?:his|her|their|my|our)\s+(?:little\s+|big\s+|baby\s+|older\s+|younger\s+)?(?:brother|sister|sibling|cousin|twin)\s*,?\s+([A-Z][\p{L}'’-]{1,29})/gu

function unknownChildNames(text: string, known: readonly string[]): string[] {
  const knownLower = new Set(known.map((n) => n.toLowerCase()))
  const found = new Set<string>()
  for (const m of text.matchAll(SIBLING_INTRO)) {
    const name = m[1]
    if (name && !knownLower.has(name.toLowerCase())) found.add(name)
  }
  return [...found]
}

/**
 * A chapter must end on a sentence, not a cliffhanger marker (GUARDRAILS.md §4.2).
 *
 * Narrowed to what §4.1 rule 3 is actually about - dread held over a chapter break - rather
 * than to every ellipsis. A trailing ellipsis after a capitalised sound word is a
 * transition, not suspense: the shark reference ends a chapter on "the whole ocean went
 * **WHOOOOSH**..." and that is the quality bar, not a violation. "...and it was right
 * behind him..." still fails, because its last word is ordinary prose.
 */
function endsOnCliffhanger(text: string): boolean {
  const plain = text
    .trimEnd()
    .replace(/[*_`>#]/g, '')
    .trimEnd()
  const interrobang = /(?:!\?|\?!)["'”’)\s]*$/.test(plain)
  if (interrobang) return true

  const ellipsis = /(?:\.{3}|…)["'”’)\s]*$/.exec(plain)
  if (!ellipsis) return false

  const before = plain.slice(0, ellipsis.index).trimEnd()
  const lastWord = /([\p{L}!]+)[^\p{L}]*$/u.exec(before)?.[1] ?? ''
  const isSoundWord = lastWord.length >= 3 && lastWord === lastWord.toUpperCase()
  return !isSoundWord
}

/**
 * GUARDRAILS.md §4.1 rule 12: no mention of AI, prompts, models or the app inside a story.
 *
 * Phrases only, never bare brand words: "Claude Monet" and "Claude Debussy" are legitimate
 * subjects for an art or music story, and a history-of-computing story may name a real
 * company. What is banned is the story talking about its own machinery.
 */
const META_TOKENS = [
  'as an ai',
  'as a language model',
  'i am an ai',
  "i'm an ai",
  'i am a language model',
  'large language model',
  'system prompt',
  'my instructions',
  'ignore previous instructions',
  'ignore all previous',
  'ignore the above',
  'ignore the rubric',
  'ignore your instructions',
  'disregard the above',
  'disregard your instructions',
  'developer mode',
  'ai assistant',
  'ai model',
  'this story was generated',
  'storytime app',
] as const

export function runDeterministicChecks(input: GateInput): DeterministicResult {
  const failures: CheckFailure[] = []
  const skipped: string[] = []
  const coverage: Record<string, number> = {}

  const parsed = StoryOutput.safeParse(input.story)
  if (!parsed.success) {
    return {
      passed: false,
      failures: [
        {
          check: 'schema_valid',
          detail: `schema_valid:${parsed.error.issues
            .slice(0, 4)
            .map((i) => `${i.path.join('.') || 'root'} ${i.message}`)
            .join(' | ')}`.slice(0, 300),
        },
      ],
      skipped: ['all other checks: story did not parse'],
      wordCount: 0,
      coverage,
      sentences: null,
    }
  }

  const story = parsed.data
  const fullText = storyText(story)
  const wordCount = storyWordCount(story)

  // ---- length ----
  if (!wordCountWithinTolerance(wordCount, input.targetWords)) {
    failures.push({
      check: 'word_count_in_range',
      detail: `word_count_in_range:${wordCount} not in ${input.targetWords.min}-${input.targetWords.max} (+/-15%)`,
    })
  }

  // ---- sentence length, against the band's limits (config/bands.json) ----
  const sentences = sentenceStats(story.chapters.map((c) => c.text).join('\n\n'), input.band)
  const tooLong = sentenceLengthFailure(sentences, input.band)
  if (tooLong) {
    failures.push({
      check: 'sentence_length',
      detail: `sentence_length:${tooLong}. Split the long sentences.`,
    })
  }

  // ---- children ----
  const youngest = Math.min(...input.children.map((c) => c.age))
  for (const child of input.children) {
    const nameRe = new RegExp(
      `(?<![\\p{L}])${child.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`,
      'iu',
    )
    const hits = story.chapters.filter((ch) => nameRe.test(ch.text)).length
    const share = story.chapters.length === 0 ? 0 : hits / story.chapters.length
    coverage[child.name] = share

    if (!nameRe.test(fullText)) {
      failures.push({ check: 'child_missing', detail: `child_missing:${child.name}` })
      continue
    }
    if (share < MIN_CHILD_CHAPTER_COVERAGE) {
      failures.push({
        check: 'child_name_coverage',
        detail: `child_name_coverage:${child.name}:${hits}/${story.chapters.length}`,
      })
    }
    if (!hasChildAction(story.chapters.map((c) => c.text).join('\n'), child.name)) {
      failures.push({ check: 'child_has_action', detail: `child_has_action:${child.name}` })
    }
  }

  const unknown = unknownChildNames(fullText, input.children.map((c) => c.name))
  for (const name of unknown) {
    failures.push({ check: 'unknown_child_name', detail: `unknown_child_name:${name}` })
  }

  // ---- true facts ----
  if (
    story.true_facts.length < STORY_MIN_TRUE_FACTS ||
    story.true_facts.length > STORY_MAX_TRUE_FACTS
  ) {
    failures.push({
      check: 'true_facts_count',
      detail: `true_facts_count:${story.true_facts.length}`,
    })
  }

  if (input.factPack) {
    const byId = new Map(input.factPack.facts.map((f) => [f.id, f]))
    for (const item of story.true_facts) {
      const fact = byId.get(item.fact_id)
      if (!fact) {
        failures.push({ check: 'unsourced_fact', detail: `unsourced_fact:${item.fact_id}` })
        continue
      }
      // GUARDRAILS.md §4.4: kid_safe, and min_age <= the youngest selected child.
      if (!fact.kid_safe) {
        failures.push({ check: 'fact_not_kid_safe', detail: `fact_not_kid_safe:${fact.id}` })
      }
      if (fact.min_age > youngest) {
        failures.push({
          check: 'fact_min_age',
          detail: `fact_min_age:${fact.id}:${fact.min_age}>${youngest}`,
        })
      }
    }
  } else {
    skipped.push('unsourced_fact/fact_min_age/fact_not_kid_safe: no fact pack supplied')
  }

  for (const miss of factTermsMissingFromStory(story)) {
    failures.push({
      check: 'true_fact_not_in_story',
      detail: `true_fact_not_in_story:${miss.fact_id}:"${miss.term}" is in the True Facts list but not in the story`.slice(
        0,
        300,
      ),
    })
  }

  // ---- ending ----
  if (story.ending_line.trim() === '') {
    failures.push({ check: 'ending_line_present', detail: 'ending_line_present:empty' })
  }

  // ---- chapter shape ----
  const chapterWords = story.chapters.map((ch) => countWords(ch.text))
  const totalChapterWords = chapterWords.reduce((a, b) => a + b, 0)
  for (const [index, words] of chapterWords.entries()) {
    if (totalChapterWords > 0 && words / totalChapterWords > MAX_CHAPTER_WORD_SHARE) {
      failures.push({
        check: 'chapter_word_share',
        detail: `chapter_word_share:${index}:${(words / totalChapterWords).toFixed(2)}`,
      })
    }
    if (endsOnCliffhanger(story.chapters[index]!.text)) {
      failures.push({ check: 'cliffhanger_marker', detail: `cliffhanger_marker:${index}` })
    }
  }

  // ---- blocklist, contact info, meta ----
  const lists: BlocklistData[] = [OUTPUT_BLOCKLIST, ...(input.extraBlocklists ?? [])]
  for (const hit of scanBlocklist(fullText, lists)) {
    failures.push({ check: 'banned_word', detail: `banned_word:${hit.match}` })
  }

  const contact = findContactInfo(fullText)
  if (contact) {
    failures.push({
      check: 'contains_url_or_contact',
      detail: `contains_url_or_contact:${contact.kind}`,
    })
  }

  const lower = fullText.toLowerCase()
  for (const token of META_TOKENS) {
    if (lower.includes(token)) {
      failures.push({ check: 'meta_content', detail: `meta_content:${token}` })
    }
  }

  return { passed: failures.length === 0, failures, skipped, wordCount, coverage, sentences }
}
