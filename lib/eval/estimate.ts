import { computeCost, models, modelForRole, pricing } from '@/lib/ai'
import { targetWords } from '@/lib/schemas'
import { loadJudgePrompt } from './judge'
import { loadReferenceCases } from './references'
import { bakeoffScenarios, evalScenarios, scenarioBand, type EvalScenario } from './scenarios'

/**
 * Pre-flight cost estimates, computed from `config/pricing.json` - never from memory.
 *
 * CLAUDE.md: "spending more than ~$20 of API budget in one eval or bake-off run" is a
 * stop-and-ask, and the ask has to come with a number. So both CLIs print this before they
 * make a single live call, and refuse to start a live run whose estimate exceeds the
 * approved ceiling.
 *
 * These are estimates. Token counts are approximated from word counts (the 4.7+ tokenizer
 * is not available offline, and Haiku 4.5's older tokenizer runs ~30% lower for identical
 * text - see config/models.json), so treat the figure as the right order of magnitude and
 * reconcile against `generation_logs` afterwards, which is what the report's reconciliation
 * section is for.
 */

/** Rough tokens per narrative word, for the 4.7+ tokenizer. */
export const TOKENS_PER_WORD = 1.35
/** Rough characters per token for prompt text. */
export const CHARS_PER_TOKEN = 3.8

/** §5's per-story call table, in tokens. */
export const STORY_CALL_TOKENS = {
  normalize: { input: 300, output: 50 },
  quality: { input: 6_000, output: 200 },
  bible_update: { input: 7_000, output: 600 },
  /**
   * The writing call: master prompt cached, request block uncached. `thinking` is what the
   * writer generates BEFORE the story, billed as output like the story itself.
   *
   * MEASURED 2026-09-29 on the first two real stories (Sonnet 5, adaptive thinking): 13,101
   * and 11,771 output tokens for ~1,400 narrative words, of which the JSON story is ~2,600.
   * Until then this table counted only the story's tokens, and every per-story figure - the
   * $0.05-0.07 quoted to the owner - was 3-4x low. The owner keeps thinking on for quality.
   */
  write: { cacheRead: 4_000, input: 1_500, thinking: 11_000 },
  /** L2 input classifier and L4 safety review, both Haiku, both on every story. */
  classify: { input: 1_300, output: 130 },
  safety: { input: 3_000, output: 60 },
  /**
   * One per NEW topic, on the fact-pack model, plus web searches.
   *
   * MEASURED 2026-09-28, not assumed. The first live build of `history-of-lego` consumed
   * **506,414 input tokens** and cost **$1.19** - because every web-search result set is
   * billed as INPUT, which this estimate previously ignored entirely (it guessed 3,000).
   * That made the fact-pack line of every eval and bake-off estimate roughly 6.6x too low.
   *
   * `max_content_tokens` would bound the input directly, but it is a **web_fetch** parameter -
   * web_search rejects it with a 400. So the only lever is the search COUNT, now 5 instead of
   * 8. Re-measure after the next build and correct this again if it is still off: an estimate
   * that is quietly wrong about its largest term is worse than no estimate.
   *
   * RE-MEASURED 2026-09-28 evening, at 5 searches: the 320k guess was low because the only
   * builds that had ever finished were the ones under undici's 300s headers timeout. With
   * that fixed (calls over 300s stream), full-length builds measured 772,072 / 31,004 and
   * 768,614 / 23,317 input/output - ~$1.85 each. Input grows faster than the search count,
   * since every search result is re-read on each later turn of the tool loop.
   */
  factpack: { input: 770_000, output: 27_000, webSearches: 5 },
} as const

export interface CostLine {
  what: string
  calls: number
  model: string
  usd: number
}

export interface CostEstimate {
  total_usd: number
  lines: CostLine[]
  assumptions: string[]
  pricing_updated_at: string
}

function judgePromptTokens(): number {
  return Math.ceil(loadJudgePrompt().text.length / CHARS_PER_TOKEN)
}

function targetWordsMid(scenario: EvalScenario): number {
  const t = targetWords({ band: scenarioBand(scenario), minutes: scenario.length_minutes })
  return (t.min + t.max) / 2
}

/** Tokens a SCORE payload costs: system prompt + request/bible/pack + the story itself. */
function scoreInputTokens(words: number): number {
  return judgePromptTokens() + 700 + Math.ceil(words * TOKENS_PER_WORD)
}

/** Judge output: six scores with evidence, three editor notes, two excerpts, plus thinking. */
const JUDGE_OUTPUT_TOKENS = 1_200
const PAIRWISE_OUTPUT_TOKENS = 900

function sum(lines: CostLine[]): number {
  return Math.round(lines.reduce((n, l) => n + l.usd, 0) * 1e6) / 1e6
}

function storyGenerationCost(writer: string, words: number): number {
  const helper = modelForRole('helper')
  const outputTokens = Math.ceil(words * TOKENS_PER_WORD) + 500 + STORY_CALL_TOKENS.write.thinking
  return (
    computeCost({ model: helper, input: STORY_CALL_TOKENS.classify.input, output: STORY_CALL_TOKENS.classify.output }) +
    computeCost({ model: helper, input: STORY_CALL_TOKENS.safety.input, output: STORY_CALL_TOKENS.safety.output }) +
    computeCost({ model: helper, input: STORY_CALL_TOKENS.normalize.input, output: STORY_CALL_TOKENS.normalize.output }) +
    computeCost({
      model: writer,
      input: STORY_CALL_TOKENS.write.input,
      cacheRead: STORY_CALL_TOKENS.write.cacheRead,
      output: outputTokens,
    }) +
    computeCost({ model: helper, input: STORY_CALL_TOKENS.quality.input, output: STORY_CALL_TOKENS.quality.output }) +
    computeCost({ model: helper, input: STORY_CALL_TOKENS.bible_update.input, output: STORY_CALL_TOKENS.bible_update.output })
  )
}

/** The §5 calibration set: 8 SCORE calls on the references and sabotages, plus 2 pairwise. */
export function estimateCalibrationCost(judge: string = modelForRole('judge_primary')): CostEstimate {
  const cases = loadReferenceCases()
  const refWords = cases.map((c) => c.wordCount)
  const lines: CostLine[] = []

  const scoreOnce = (words: number): number =>
    computeCost({ model: judge, input: scoreInputTokens(words), output: JUDGE_OUTPUT_TOKENS })

  lines.push({
    what: 'SCORE the four reference stories',
    calls: cases.length,
    model: judge,
    usd: refWords.reduce((n, w) => n + scoreOnce(w), 0),
  })
  // Four sabotaged variants: same stories, one padded by 900 words.
  const sabotageWords = [
    refWords[0] ?? 1_500,
    refWords[3] ?? 2_600,
    refWords[2] ?? 1_900,
    (refWords[1] ?? 2_500) + 900,
  ]
  lines.push({
    what: 'SCORE the four sabotaged variants',
    calls: 4,
    model: judge,
    usd: sabotageWords.reduce((n, w) => n + scoreOnce(w), 0),
  })
  const legoWords = refWords[0] ?? 1_500
  lines.push({
    what: 'PAIRWISE original vs sabotaged LEGO story, both orders',
    calls: 2,
    model: judge,
    usd:
      2 *
      computeCost({
        model: judge,
        input: scoreInputTokens(legoWords * 2),
        output: PAIRWISE_OUTPUT_TOKENS,
      }),
  })

  return {
    total_usd: sum(lines),
    lines,
    assumptions: [
      `${TOKENS_PER_WORD} tokens per narrative word; ${CHARS_PER_TOKEN} characters per prompt token.`,
      `Judge output assumed ${JUDGE_OUTPUT_TOKENS} tokens for SCORE and ${PAIRWISE_OUTPUT_TOKENS} for PAIRWISE, thinking included.`,
      'No prompt-cache discount assumed on the judge system block; in practice the second and later calls in a run read it from cache, so the real figure is lower.',
    ],
    pricing_updated_at: pricing.updated_at,
  }
}

export function estimateEvalCost(
  opts: {
    writer?: string
    judge?: string
    scenarios?: EvalScenario[]
    includeCalibration?: boolean
    /** Topics whose pack is already `ready`: shared, so this run pays nothing for them. */
    builtTopics?: ReadonlySet<string>
  } = {},
): CostEstimate {
  const writer = opts.writer ?? modelForRole('writer')
  const judge = opts.judge ?? modelForRole('judge_primary')
  const scenarios = opts.scenarios ?? evalScenarios()
  const lines: CostLine[] = []

  const topics = new Set(scenarios.map((s) => s.topic_key).filter((t) => !opts.builtTopics?.has(t)))
  lines.push({
    what: `fact packs for ${topics.size} distinct topic(s) not yet built`,
    calls: topics.size,
    model: modelForRole('factpack'),
    usd:
      topics.size *
      computeCost({
        model: modelForRole('factpack'),
        input: STORY_CALL_TOKENS.factpack.input,
        output: STORY_CALL_TOKENS.factpack.output,
        webSearches: STORY_CALL_TOKENS.factpack.webSearches,
      }),
  })
  lines.push({
    what: `generate ${scenarios.length} stories (normalize + write + quality + bible)`,
    calls: scenarios.length * 4,
    model: writer,
    usd: scenarios.reduce((n, s) => n + storyGenerationCost(writer, targetWordsMid(s)), 0),
  })
  lines.push({
    what: `SCORE ${scenarios.length} stories`,
    calls: scenarios.length,
    model: judge,
    usd: scenarios.reduce(
      (n, s) =>
        n + computeCost({ model: judge, input: scoreInputTokens(targetWordsMid(s)), output: JUDGE_OUTPUT_TOKENS }),
      0,
    ),
  })

  const assumptions = [
    opts.builtTopics
      ? `Fact packs already \`ready\` are shared and cost nothing (${opts.builtTopics.size} found).`
      : 'Every topic needs a new fact pack (no library lookup was passed).',
    'Story length assumed at the middle of each scenario\'s target range.',
  ]
  if (opts.includeCalibration !== false) {
    const cal = estimateCalibrationCost(judge)
    lines.push({ what: 'judge calibration (§5)', calls: 10, model: judge, usd: cal.total_usd })
    assumptions.push(...cal.assumptions)
  }

  return { total_usd: sum(lines), lines, assumptions, pricing_updated_at: pricing.updated_at }
}

export function estimateBakeoffCost(
  opts: {
    contestants?: string[]
    samples?: number
    scenarios?: EvalScenario[]
    baseline?: string
    secondJudgeLimit?: number
    pairwiseVsBest?: boolean
    judge?: string
    secondJudge?: string
    includeCalibration?: boolean
    /** Topics whose pack is already `ready`: shared, so this run pays nothing for them. */
    builtTopics?: ReadonlySet<string>
  } = {},
): CostEstimate {
  const contestants = opts.contestants ?? models.bakeoff_contestants
  const samples = opts.samples ?? 3
  const scenarios = opts.scenarios ?? bakeoffScenarios()
  const judge = opts.judge ?? modelForRole('judge_primary')
  const secondJudge = opts.secondJudge ?? modelForRole('judge_secondary')
  const secondJudgeLimit = opts.secondJudgeLimit ?? 12
  const pairwiseVsBest = opts.pairwiseVsBest ?? true
  const lines: CostLine[] = []

  const topics = new Set(scenarios.map((s) => s.topic_key).filter((t) => !opts.builtTopics?.has(t)))
  lines.push({
    what: `fact packs for ${topics.size} distinct topic(s) not yet built, built once and shared`,
    calls: topics.size,
    model: modelForRole('factpack'),
    usd:
      topics.size *
      computeCost({
        model: modelForRole('factpack'),
        input: STORY_CALL_TOKENS.factpack.input,
        output: STORY_CALL_TOKENS.factpack.output,
        webSearches: STORY_CALL_TOKENS.factpack.webSearches,
      }),
  })

  for (const contestant of contestants) {
    const usd = scenarios.reduce(
      (n, s) => n + samples * storyGenerationCost(contestant, targetWordsMid(s)),
      0,
    )
    lines.push({
      what: `generate ${scenarios.length * samples} stories on ${contestant}`,
      calls: scenarios.length * samples * 4,
      model: contestant,
      usd,
    })
  }

  const storyCount = scenarios.length * contestants.length * samples
  lines.push({
    what: `SCORE all ${storyCount} stories`,
    calls: storyCount,
    model: judge,
    usd:
      contestants.length *
      samples *
      scenarios.reduce(
        (n, s) =>
          n + computeCost({ model: judge, input: scoreInputTokens(targetWordsMid(s)), output: JUDGE_OUTPUT_TOKENS }),
        0,
      ),
  })

  const pairwisePerSet = scenarios.reduce(
    (n, s) =>
      n +
      2 *
        computeCost({
          model: judge,
          input: scoreInputTokens(targetWordsMid(s) * 2),
          output: PAIRWISE_OUTPUT_TOKENS,
        }),
    0,
  )
  const challengers = Math.max(0, contestants.length - 1)
  lines.push({
    what: `PAIRWISE ${challengers} contestant(s) vs the baseline, both orders`,
    calls: challengers * scenarios.length * 2,
    model: judge,
    usd: challengers * pairwisePerSet,
  })
  if (pairwiseVsBest) {
    lines.push({
      what: `PAIRWISE ${challengers} contestant(s) vs the best contestant, both orders (needed for §6's decision rule)`,
      calls: challengers * scenarios.length * 2,
      model: judge,
      usd: challengers * pairwisePerSet,
    })
  }

  const doubleJudged = Math.min(secondJudgeLimit, challengers * scenarios.length * (pairwiseVsBest ? 2 : 1))
  const avgWords = scenarios.reduce((n, s) => n + targetWordsMid(s), 0) / Math.max(1, scenarios.length)
  lines.push({
    what: `second judge re-SCOREs both stories in the ${doubleJudged} highest-stakes comparisons`,
    calls: doubleJudged * 2,
    model: secondJudge,
    usd:
      doubleJudged *
      2 *
      computeCost({ model: secondJudge, input: scoreInputTokens(avgWords), output: JUDGE_OUTPUT_TOKENS }),
  })

  const assumptions = [
    opts.builtTopics
      ? `Fact packs already \`ready\` are shared and cost nothing (${opts.builtTopics.size} found).`
      : 'Every topic needs a new fact pack (no library lookup was passed).',
    'Story length assumed at the middle of each scenario\'s target range.',
    'No prompt-cache discount assumed on the judge system block; the real figure will be lower.',
    `Rewrites are not included: a gate failure adds one more writing call. A 10% rewrite rate adds roughly 10% to the generation lines.`,
  ]
  if (opts.includeCalibration !== false) {
    const cal = estimateCalibrationCost(judge)
    lines.push({ what: 'judge calibration (§5)', calls: 10, model: judge, usd: cal.total_usd })
  }

  return { total_usd: sum(lines), lines, assumptions, pricing_updated_at: pricing.updated_at }
}

export function formatEstimate(label: string, estimate: CostEstimate): string {
  const lines = [`${label} - estimated live cost $${estimate.total_usd.toFixed(2)}`]
  lines.push(`  prices from config/pricing.json, updated ${estimate.pricing_updated_at}`)
  for (const l of estimate.lines) {
    lines.push(`  $${l.usd.toFixed(4).padStart(9)}  ${String(l.calls).padStart(4)} calls  ${l.what}`)
  }
  lines.push('  assumptions:')
  for (const a of estimate.assumptions) lines.push(`    - ${a}`)
  return lines.join('\n')
}
