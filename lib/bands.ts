import bandsJson from '@/config/bands.json'
import { MAX_SCARY_LEVEL, type AgeBand } from '@/lib/schemas/common'

/**
 * The band rubric (config/bands.json): one standard for the writer, both reviewers and the
 * gate's code.
 *
 * Why it exists. The owner's first real stories were each rewritten, and the rewrite failed
 * too, because three parties worked to three rulebooks: the master prompt asked for a "big
 * kid" hook in every chapter and gave no sentence numbers; the quality reviewer had its own
 * band table, saw only the youngest age and marked the hooks and the True Facts list down;
 * the two reviewers defined the scary scale differently; and the code's band-A limit of 0
 * rejected even the suspense in the owner's own band-A reference story. A writer cannot
 * pass a gate whose rules it was never shown.
 *
 * So the rubric is written ONCE and rendered into every prompt that needs it
 * (`{{band_rubric}}`, `{{suspense_scale}}` - see lib/prompts.ts), and what can be measured
 * (sentence length) is measured here rather than judged by a model.
 */

export interface BandSentenceRule {
  target: string
  /** A sentence longer than this many words is "long" for the band. */
  long_sentence_words: number
  /** Gate limit: mean words per sentence. */
  limit_mean_words: number
  /** Gate limit: share of sentences that are long, 0-1. */
  limit_long_share: number
}

export interface BandRule {
  ages: string
  sentences: BandSentenceRule
  vocabulary: string
  humour: string
  ending: string
}

const BANDS = bandsJson.bands as Record<AgeBand, BandRule>
const ORDER: readonly AgeBand[] = ['A', 'B', 'C', 'D']

export function bandRule(band: AgeBand): BandRule {
  return BANDS[band]
}

/** The 0-3 scale and the per-band limits, identical for the writer and both reviewers. */
export function renderSuspenseScale(): string {
  const limits = ORDER.map((b) => `${b}: ${MAX_SCARY_LEVEL[b]}`).join(', ')
  return [
    ...bandsJson.suspense_scale.map((line) => `- ${line}`),
    '',
    `Highest level allowed, by band — ${limits}. Whatever the level, it is resolved before ` +
      'its chapter ends: this is read at bedtime.',
  ].join('\n')
}

/** The whole rubric as prompt text. Static, so it is safe inside the cached master block. */
export function renderBandRubric(): string {
  const rows = ORDER.map((b) => {
    const r = BANDS[b]
    return `| ${b} | ${r.ages} | ${r.sentences.target} | ${r.vocabulary} | ${MAX_SCARY_LEVEL[b]} | ${r.humour} | ${r.ending} |`
  })
  return [
    '| Band | Ages | Sentences | Vocabulary | Suspense limit | Humour | Ending line |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    'Sentence length and story length are **measured by code**.',
    '',
    bandsJson.big_word,
    '',
    bandsJson.mixed_ages,
    '',
    '**Suspense scale** — the peak over the whole story:',
    '',
    renderSuspenseScale(),
    '',
    bandsJson.true_facts,
  ].join('\n')
}

/** Placeholders a prompt file may use. Resolved at load time, so the result is static. */
export const PROMPT_PLACEHOLDERS: Record<string, () => string> = {
  band_rubric: renderBandRubric,
  suspense_scale: renderSuspenseScale,
}

export function resolvePromptPlaceholders(text: string): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (whole, name: string) => {
    const render = PROMPT_PLACEHOLDERS[name]
    if (!render) throw new Error(`unknown prompt placeholder ${whole}`)
    return render()
  })
}

// ---------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------

export interface SentenceStats {
  sentences: number
  meanWords: number
  /** Share of sentences longer than the band's `long_sentence_words`, 0-1. */
  longShare: number
  longest: number
}

/**
 * Split read-aloud prose into sentences. Markdown emphasis is dropped first; a closing quote
 * or bracket stays with the sentence it ends. Fragments with no letters ("...", "—") are not
 * sentences. Dialogue and its tag count separately ("No way," / whispered Cruz.) - the same
 * rule is applied to the references the limits were calibrated on, so it cancels out.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/[*_`]/g, '')
    .split(/(?<=[.!?…]["”’)]?)\s+/u)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s))
}

export function sentenceStats(text: string, band: AgeBand): SentenceStats {
  const lengths = splitSentences(text).map((s) => s.split(/\s+/).length)
  if (lengths.length === 0) return { sentences: 0, meanWords: 0, longShare: 0, longest: 0 }
  const long = BANDS[band].sentences.long_sentence_words
  return {
    sentences: lengths.length,
    meanWords: lengths.reduce((a, b) => a + b, 0) / lengths.length,
    longShare: lengths.filter((l) => l > long).length / lengths.length,
    longest: Math.max(...lengths),
  }
}

/** Null when the prose is within the band's limits; otherwise what to tell the writer. */
export function sentenceLengthFailure(stats: SentenceStats, band: AgeBand): string | null {
  const rule = BANDS[band].sentences
  const problems: string[] = []
  if (stats.meanWords > rule.limit_mean_words) {
    problems.push(`average ${stats.meanWords.toFixed(1)} words (limit ${rule.limit_mean_words})`)
  }
  if (stats.longShare > rule.limit_long_share) {
    problems.push(
      `${Math.round(stats.longShare * 100)}% of sentences over ${rule.long_sentence_words} words ` +
        `(limit ${Math.round(rule.limit_long_share * 100)}%)`,
    )
  }
  return problems.length === 0 ? null : problems.join('; ')
}
