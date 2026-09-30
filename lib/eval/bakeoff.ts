import { MemoryLogSink, models, modelForRole, priceFor, pricing, type GenerationLogSink } from '@/lib/ai'
import { JUDGE_CRITERIA, targetWords, type JudgeScore } from '@/lib/schemas'
import { runCalibration, type CalibrationResult } from './calibration'
import { loadJudgePrompt, pairwiseWithSwap, scoreStory } from './judge'
import { loadPipeline, type StoryPipeline, type StoryProvider } from './pipeline'
import { narrativeWordCount } from './render'
import { median, medianIndex, quantile } from './stats'
import { bakeoffScenarios, scenarioBand, selectScenarios, type EvalScenario } from './scenarios'
import type { CapContext, JudgeContext, JudgeableStory } from './types'

/**
 * F14 / JUDGE_AGENT.md §6 - the model bake-off.
 *
 * The protocol in §6, in order:
 *   1. fact packs built once and shared (the pipeline's job - see pipeline.ts);
 *   2. each scenario × contestant generated N times through the real pipeline;
 *   3. every story SCOREd blind;
 *   4. every contestant PAIRWISEd against the baseline on each scenario, using the
 *      median-scored story of each, in both orders;
 *   5. step 3 repeated with a second judge on the highest-stakes comparisons, and an
 *      agreement rate reported.
 *
 * Two honesty constraints run through all of it:
 *
 *   - **Both judges are also contestants.** Fable 5.1 and Opus 5.5 are the two strongest
 *     models available, so §2's "use the strongest model as judge" and "never the same
 *     model as a contestant" cannot both hold (DECISIONS.md #3). The mitigation is step 5,
 *     and the report states the self-preference caveat on those two rows rather than
 *     burying it.
 *   - **Nothing identifying reaches the judge.** Contestants are carried as model ids in
 *     this module and mapped into the report at the end; the judge sees only the story,
 *     and `assertBlind` checks that on every call.
 */

export const JUDGE_PURPOSES = new Set(['judge_score', 'judge_pairwise'])

export interface BakeoffConfig {
  /** Scenario ids, or undefined for all bake-off scenarios. */
  scenarios?: string[]
  /** Contestant model ids. Default: config/models.json `bakeoff_contestants`. */
  contestants?: string[]
  /** Samples per scenario × contestant. §2 asks for 3. */
  samples?: number
  /** The contestant every other one is compared against. Default: the `writer` role. */
  baseline?: string
  /** How many comparisons get a second judge. §6 step 5 says 12. */
  secondJudgeLimit?: number
  /**
   * Also run pairwise against the top-scoring contestant when it is not the baseline.
   * §6's decision rule is stated in terms of "loss rate against the best contestant", and
   * step 4 only compares against the baseline - so without this the headline rule cannot
   * be computed from the data, only estimated. Costs one extra swapped comparison per
   * scenario per contestant.
   */
  pairwiseVsBest?: boolean
  pipeline?: StoryPipeline
  provider?: StoryProvider
  sink?: GenerationLogSink
  /** Skip calibration. Only for harness tests - never for a run that produces numbers. */
  skipCalibration?: boolean
  signal?: AbortSignal
  onProgress?: (line: string) => void
}

export interface BakeoffStoryRecord {
  scenario_id: string
  contestant: string
  sample: number
  story_id: string
  band: string
  word_count: number
  target_words: { min: number; max: number }
  gate: { outcome: string; hard_violations: number; failures: string[] } | null
  judge_ok: boolean
  judge_error: string | null
  scores_raw: JudgeScore['scores'] | null
  overall_raw: number | null
  overall_final: number | null
  caps_applied: string[]
  disqualified: boolean
  cap_context: CapContext | null
  best_moment: string | null
  worst_moment: string | null
  generation_cost_usd: number
  judge_cost_usd: number
  latency_to_first_chapter_ms: number | null
  latency_total_ms: number
  attempts: number
}

export interface SecondJudgeCheck {
  model: string
  challenger_overall: number | null
  baseline_overall: number | null
  /** Does the second judge put the same story ahead as the primary's pairwise verdict? */
  agrees_on_winner: boolean
  /** Share of the six criteria where both judges gave the same integer to both stories. */
  criterion_agreement: number
  errors: string[]
}

export interface BakeoffComparison {
  scenario_id: string
  challenger: string
  baseline: string
  /** Which sample of each was used - §6 step 4 says the median-scored story. */
  challenger_sample: number
  baseline_sample: number
  verdict: 'A' | 'B' | 'TIE'
  /** A = challenger. TIE here may be a real tie or a position flip; `flipped` says which. */
  flipped: boolean
  confidence: number
  first_order_verdict: string | null
  swapped_order_verdict: string | null
  per_criterion_first: Record<string, string> | null
  stakes: number
  errors: string[]
  second_judge: SecondJudgeCheck | null
  judge_cost_usd: number
}

export interface ContestantSummary {
  model: string
  display_name: string
  is_also_a_judge: boolean
  stories: number
  judge_errors: number
  criterion_medians: Record<string, number>
  overall_median: number
  overall_min: number
  disqualified: number
  gate_flag_rate: number
  gate_rewrite_rate: number
  median_cost_usd: number
  p95_cost_usd: number
  median_total_latency_ms: number
  p95_total_latency_ms: number
  median_first_chapter_ms: number | null
  p95_first_chapter_ms: number | null
  vs_baseline: { wins: number; ties: number; losses: number; avg_confidence: number } | null
  vs_best: { wins: number; ties: number; losses: number; avg_confidence: number } | null
}

export interface BakeoffResult {
  version: 1
  kind: 'bakeoff'
  ran_at: string
  date: string
  pipeline: 'live' | 'fixture'
  pipeline_describe: string
  /** True when the stories were not generated by a model. Never treat these as results. */
  synthetic: boolean
  config: {
    scenarios: string[]
    contestants: string[]
    samples: number
    baseline: string
    judge_primary: string
    judge_secondary: string
    second_judge_limit: number
    pairwise_vs_best: boolean
  }
  /** §6: "record the model IDs and prices in eval/results/bakeoff-<date>.json". */
  models: Record<string, { display_name: string; input: number; output: number; cache_read: number }>
  pricing_updated_at: string
  judge_prompt: { version: string; sha256: string }
  calibration: CalibrationResult | { skipped: true; reason: string }
  stories: BakeoffStoryRecord[]
  comparisons: BakeoffComparison[]
  summaries: ContestantSummary[]
  agreement: {
    comparisons_double_judged: number
    winner_agreement_rate: number
    criterion_agreement_rate: number
    second_judge_model: string
  }
  cost: {
    generation_usd: number
    judge_usd: number
    total_usd: number
    reconciliation: {
      logged_generation_usd: number
      reported_generation_usd: number
      delta_pct: number
      /** §7 VT: the report's cost figures reconcile with generation_logs within 0.1%. */
      within_tolerance: boolean
      log_rows: number
    }
  }
  notes: string[]
}

function judgeContextFor(scenario: EvalScenario): JudgeContext {
  const band = scenarioBand(scenario)
  return {
    children: scenario.children.map((c) => ({
      name: c.name,
      age: c.age,
      likes: c.likes,
      notes: c.notes,
    })),
    age_band: band,
    tones: scenario.tones,
    length_minutes: scenario.length_minutes,
    target_words: targetWords({ band, minutes: scenario.length_minutes }),
    topic_label: scenario.topic_input,
    bible: scenario.bible,
    fact_pack: null,
  }
}

function storyId(scenario: string, contestant: string, sample: number): string {
  return `bakeoff:${scenario}:${contestant}:${sample}`
}

const NO_PROGRESS = (): void => {}

export async function runBakeoff(config: BakeoffConfig = {}): Promise<BakeoffResult> {
  const progress = config.onProgress ?? NO_PROGRESS
  const all = bakeoffScenarios()
  const scenarios = config.scenarios ? selectScenarios(all, config.scenarios.join(',')) : all
  const contestants = config.contestants ?? models.bakeoff_contestants
  const samples = config.samples ?? 3
  const baseline = config.baseline ?? modelForRole('writer')
  const secondJudgeLimit = config.secondJudgeLimit ?? 12
  const pairwiseVsBest = config.pairwiseVsBest ?? true
  const judgePrimary = modelForRole('judge_primary')
  const judgeSecondary = modelForRole('judge_secondary')
  const sink = config.sink ?? new MemoryLogSink()
  const prompt = loadJudgePrompt()

  if (!contestants.includes(baseline)) {
    throw new Error(
      `baseline "${baseline}" is not among the contestants (${contestants.join(', ')}). ` +
        `§6 step 4 compares every contestant against the baseline, so it must be one of them.`,
    )
  }

  // ---- Calibration gate. F13 AC / §5: nothing counts until it passes.
  let calibration: BakeoffResult['calibration']
  if (config.skipCalibration) {
    calibration = {
      skipped: true,
      reason:
        'skipCalibration was set. JUDGE_AGENT.md §5 requires calibration before a bake-off; ' +
        'a result with this flag set is a harness test, not a bake-off.',
    }
  } else {
    progress('Running judge calibration (JUDGE_AGENT.md §5)…')
    calibration = await runCalibration({ sink, ...(config.signal ? { signal: config.signal } : {}) })
    if (!calibration.passed) {
      const failed = calibration.expectations.filter((e) => !e.passed).map((e) => e.id)
      throw new Error(
        `Judge calibration failed (${failed.join(', ')}). ` +
          `JUDGE_AGENT.md §5: stop and fix the judge prompt - never the references. ` +
          `No bake-off numbers are produced from an uncalibrated judge.`,
      )
    }
  }

  const pipeline = config.pipeline ?? (await loadPipeline(config.provider ? { mode: 'fixture', provider: config.provider } : {}))

  // ---- Steps 2 and 3: generate and score.
  const stories: BakeoffStoryRecord[] = []
  const storyText = new Map<string, JudgeableStory>()

  for (const scenario of scenarios) {
    const context = judgeContextFor(scenario)
    for (const contestant of contestants) {
      for (let sample = 1; sample <= samples; sample += 1) {
        const id = storyId(scenario.id, contestant, sample)
        progress(`generate ${id}`)
        const generated = await pipeline.generate({
          scenario,
          writingModel: contestant,
          sample,
          sink,
          storyId: id,
          ...(config.signal ? { signal: config.signal } : {}),
        })
        storyText.set(id, generated.story)

        progress(`score ${id}`)
        const scored = await scoreStory({
          context,
          story: generated.story,
          gate: generated.gate,
          factPack: generated.factPack,
          sink,
          storyId: id,
          ...(config.signal ? { signal: config.signal } : {}),
        })

        stories.push({
          scenario_id: scenario.id,
          contestant,
          sample,
          story_id: id,
          band: scenarioBand(scenario),
          word_count: narrativeWordCount(generated.story),
          target_words: context.target_words,
          gate: generated.gate
            ? {
                outcome: generated.gate.outcome ?? 'unknown',
                hard_violations: generated.gate.hard_violations?.length ?? 0,
                failures: (generated.gate.failures ?? []).map((f) => f.check),
              }
            : null,
          judge_ok: scored.ok,
          judge_error: scored.ok ? null : scored.reason,
          scores_raw: scored.ok ? scored.raw.scores : null,
          overall_raw: scored.ok ? scored.raw.overall : null,
          overall_final: scored.ok ? scored.final.overall : null,
          caps_applied: scored.ok ? scored.final.caps_applied : [],
          disqualified: scored.ok ? scored.final.disqualified : false,
          cap_context: scored.ok ? scored.capContext : null,
          best_moment: scored.ok ? scored.best_moment : null,
          worst_moment: scored.ok ? scored.worst_moment : null,
          generation_cost_usd: generated.costUsd,
          judge_cost_usd: scored.costUsd,
          latency_to_first_chapter_ms: generated.latency.toFirstChapterMs,
          latency_total_ms: generated.latency.totalMs,
          attempts: generated.attempts,
        })
      }
    }
  }

  // ---- Step 4: pairwise against the baseline, both orders, on the median-scored story.
  const medianStory = (scenarioId: string, contestant: string): BakeoffStoryRecord | null => {
    const pool = stories.filter(
      (s) => s.scenario_id === scenarioId && s.contestant === contestant && s.overall_final !== null,
    )
    if (pool.length === 0) return null
    const at = medianIndex(pool.map((s) => s.overall_final!))
    return pool[at] ?? null
  }

  const comparisons: BakeoffComparison[] = []

  const compare = async (
    scenario: EvalScenario,
    challenger: string,
    against: string,
  ): Promise<BakeoffComparison | null> => {
    const a = medianStory(scenario.id, challenger)
    const b = medianStory(scenario.id, against)
    if (!a || !b) return null
    const aStory = storyText.get(a.story_id)
    const bStory = storyText.get(b.story_id)
    if (!aStory || !bStory) return null

    progress(`pairwise ${scenario.id}: ${challenger} vs ${against}`)
    const swap = await pairwiseWithSwap({
      context: judgeContextFor(scenario),
      challenger: aStory,
      baseline: bStory,
      common: {
        sink,
        storyId: a.story_id,
        ...(config.signal ? { signal: config.signal } : {}),
      },
    })
    return {
      scenario_id: scenario.id,
      challenger,
      baseline: against,
      challenger_sample: a.sample,
      baseline_sample: b.sample,
      verdict: swap.verdict,
      flipped: swap.flipped,
      confidence: swap.confidence,
      first_order_verdict: swap.firstOrder?.verdict ?? null,
      swapped_order_verdict: swap.secondOrder?.verdict ?? null,
      per_criterion_first: swap.firstOrder?.per_criterion ?? null,
      // Stakes: a close call decides the outcome, a blowout does not.
      stakes: Math.abs((a.overall_final ?? 0) - (b.overall_final ?? 0)),
      errors: swap.errors,
      second_judge: null,
      judge_cost_usd: swap.costUsd,
    }
  }

  for (const scenario of scenarios) {
    for (const contestant of contestants) {
      if (contestant === baseline) continue
      const c = await compare(scenario, contestant, baseline)
      if (c) comparisons.push(c)
    }
  }

  // Interim medians, needed to find "the best contestant" for the §6 decision rule.
  const overallMedians = new Map<string, number>()
  for (const contestant of contestants) {
    const values = stories
      .filter((s) => s.contestant === contestant && s.overall_final !== null)
      .map((s) => s.overall_final!)
    overallMedians.set(contestant, values.length === 0 ? Number.NaN : median(values))
  }
  const best = [...overallMedians.entries()]
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? baseline

  if (pairwiseVsBest && best !== baseline) {
    for (const scenario of scenarios) {
      for (const contestant of contestants) {
        if (contestant === best) continue
        const c = await compare(scenario, contestant, best)
        if (c) comparisons.push(c)
      }
    }
  }

  // ---- Step 5: a second judge on the highest-stakes comparisons, and an agreement rate.
  const highestStakes = [...comparisons]
    .sort((a, b) => a.stakes - b.stakes || a.scenario_id.localeCompare(b.scenario_id))
    .slice(0, secondJudgeLimit)

  for (const comparison of highestStakes) {
    const scenario = scenarios.find((s) => s.id === comparison.scenario_id)
    if (!scenario) continue
    const a = medianStory(comparison.scenario_id, comparison.challenger)
    const b = medianStory(comparison.scenario_id, comparison.baseline)
    const aStory = a ? storyText.get(a.story_id) : undefined
    const bStory = b ? storyText.get(b.story_id) : undefined
    if (!a || !b || !aStory || !bStory) continue

    progress(`second judge ${comparison.scenario_id}: ${comparison.challenger} vs ${comparison.baseline}`)
    const context = judgeContextFor(scenario)
    const common = {
      role: 'judge_secondary' as const,
      sink,
      ...(config.signal ? { signal: config.signal } : {}),
    }
    const secondA = await scoreStory({ ...common, context, story: aStory, gate: null, factPack: null, storyId: a.story_id })
    const secondB = await scoreStory({ ...common, context, story: bStory, gate: null, factPack: null, storyId: b.story_id })

    const errors: string[] = []
    if (!secondA.ok) errors.push(`challenger: ${secondA.reason}`)
    if (!secondB.ok) errors.push(`baseline: ${secondB.reason}`)

    const challengerOverall = secondA.ok ? secondA.final.overall : null
    const baselineOverall = secondB.ok ? secondB.final.overall : null
    const secondVerdict: 'A' | 'B' | 'TIE' =
      challengerOverall === null || baselineOverall === null
        ? 'TIE'
        : challengerOverall > baselineOverall
          ? 'A'
          : challengerOverall < baselineOverall
            ? 'B'
            : 'TIE'

    let criterionAgreement = Number.NaN
    if (secondA.ok && secondB.ok && a.scores_raw && b.scores_raw) {
      let same = 0
      for (const crit of JUDGE_CRITERIA) {
        const primaryLead = Math.sign(a.scores_raw[crit] - b.scores_raw[crit])
        const secondLead = Math.sign(secondA.raw.scores[crit] - secondB.raw.scores[crit])
        if (primaryLead === secondLead) same += 1
      }
      criterionAgreement = same / JUDGE_CRITERIA.length
    }

    comparison.second_judge = {
      model: secondA.model || secondB.model || judgeSecondary,
      challenger_overall: challengerOverall,
      baseline_overall: baselineOverall,
      agrees_on_winner: secondVerdict === comparison.verdict,
      criterion_agreement: criterionAgreement,
      errors,
    }
    comparison.judge_cost_usd += secondA.costUsd + secondB.costUsd
  }

  // ---- Summaries, cost and reconciliation.
  const summaries = contestants.map((contestant) =>
    summarize({ contestant, baseline, best, stories, comparisons }),
  )

  const generationUsd = round6(stories.reduce((n, s) => n + s.generation_cost_usd, 0))
  const judgeFromStories = stories.reduce((n, s) => n + s.judge_cost_usd, 0)
  const judgeFromComparisons = comparisons.reduce((n, c) => n + c.judge_cost_usd, 0)
  const calibrationCost = 'cost_usd' in calibration ? calibration.cost_usd : 0
  const judgeUsd = round6(judgeFromStories + judgeFromComparisons + calibrationCost)

  const rows = 'rows' in sink ? (sink as MemoryLogSink).rows : []
  const loggedGeneration = round6(
    rows.filter((r) => !JUDGE_PURPOSES.has(r.purpose)).reduce((n, r) => n + r.cost_usd, 0),
  )
  const delta =
    loggedGeneration === 0 && generationUsd === 0
      ? 0
      : Math.abs(loggedGeneration - generationUsd) / Math.max(loggedGeneration, 1e-9)

  const notes = [
    `Both judges are also contestants: ${judgePrimary} (primary) and ${judgeSecondary} (secondary). DECISIONS.md #3 - §2 wants the strongest model judging and the two strongest are both in the field, so self-preference bias is reported rather than engineered away. Treat those two rows with the caveat attached.`,
    `Pairwise verdicts are position-swapped: every comparison ran in both orders and a verdict that flipped is recorded as a TIE (§2).`,
    `The judge never saw a model id: every payload is checked by lib/eval/blind.ts before it is sent.`,
  ]
  if (best !== baseline && !pairwiseVsBest) {
    notes.push(
      `§6's decision rule is stated as "loss rate against the best contestant", but pairwiseVsBest was off and the best contestant (${best}) is not the baseline (${baseline}). Loss rates below are against the baseline only.`,
    )
  }
  if (pipeline.kind === 'fixture') {
    notes.push(
      'PIPELINE: FIXTURE. The stories in this run were not generated by a model, so every score, pairwise verdict and cost figure here describes the harness, not the contestants. Not a bake-off result.',
    )
  }

  return {
    version: 1,
    kind: 'bakeoff',
    ran_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    pipeline: pipeline.kind,
    pipeline_describe: pipeline.describe,
    synthetic: pipeline.kind === 'fixture',
    config: {
      scenarios: scenarios.map((s) => s.id),
      contestants,
      samples,
      baseline,
      judge_primary: judgePrimary,
      judge_secondary: judgeSecondary,
      second_judge_limit: secondJudgeLimit,
      pairwise_vs_best: pairwiseVsBest,
    },
    models: Object.fromEntries(
      contestants.map((m) => {
        const p = priceFor(m)
        return [m, { display_name: p.display_name, input: p.input, output: p.output, cache_read: p.cache_read }]
      }),
    ),
    pricing_updated_at: pricing.updated_at,
    judge_prompt: { version: prompt.version, sha256: prompt.sha256 },
    calibration,
    stories,
    comparisons,
    summaries,
    agreement: agreementRate(comparisons, judgeSecondary),
    cost: {
      generation_usd: generationUsd,
      judge_usd: judgeUsd,
      total_usd: round6(generationUsd + judgeUsd),
      reconciliation: {
        logged_generation_usd: loggedGeneration,
        reported_generation_usd: generationUsd,
        delta_pct: Math.round(delta * 1e6) / 1e4,
        within_tolerance: delta <= 0.001,
        log_rows: rows.length,
      },
    },
    notes,
  }
}

// ---------------------------------------------------------------------------

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

function tally(
  comparisons: BakeoffComparison[],
): { wins: number; ties: number; losses: number; avg_confidence: number } {
  const wins = comparisons.filter((c) => c.verdict === 'A').length
  const losses = comparisons.filter((c) => c.verdict === 'B').length
  const ties = comparisons.filter((c) => c.verdict === 'TIE').length
  const avg =
    comparisons.length === 0
      ? Number.NaN
      : comparisons.reduce((n, c) => n + c.confidence, 0) / comparisons.length
  return { wins, ties, losses, avg_confidence: Math.round(avg * 100) / 100 }
}

function summarize(args: {
  contestant: string
  baseline: string
  best: string
  stories: BakeoffStoryRecord[]
  comparisons: BakeoffComparison[]
}): ContestantSummary {
  const mine = args.stories.filter((s) => s.contestant === args.contestant)
  const scored = mine.filter((s) => s.scores_raw !== null && s.overall_final !== null)
  const overalls = scored.map((s) => s.overall_final!)
  const judgeIds = new Set([modelForRole('judge_primary'), modelForRole('judge_secondary')])

  const criterionMedians: Record<string, number> = {}
  for (const crit of JUDGE_CRITERIA) {
    criterionMedians[crit] = median(scored.map((s) => s.scores_raw![crit]))
  }

  const flagged = mine.filter((s) => s.gate?.outcome === 'flagged' || s.gate?.outcome === 'discarded')
  const rewritten = mine.filter((s) => s.gate?.outcome === 'rewrite' || s.attempts > 1)

  const vsBaseline = args.comparisons.filter(
    (c) => c.challenger === args.contestant && c.baseline === args.baseline,
  )
  const vsBest = args.comparisons.filter(
    (c) => c.challenger === args.contestant && c.baseline === args.best,
  )

  return {
    model: args.contestant,
    display_name: priceFor(args.contestant).display_name,
    is_also_a_judge: judgeIds.has(args.contestant),
    stories: mine.length,
    judge_errors: mine.filter((s) => !s.judge_ok).length,
    criterion_medians: criterionMedians,
    overall_median: median(overalls),
    overall_min: overalls.length === 0 ? Number.NaN : Math.min(...overalls),
    disqualified: mine.filter((s) => s.disqualified).length,
    gate_flag_rate: mine.length === 0 ? Number.NaN : flagged.length / mine.length,
    gate_rewrite_rate: mine.length === 0 ? Number.NaN : rewritten.length / mine.length,
    median_cost_usd: median(mine.map((s) => s.generation_cost_usd)),
    p95_cost_usd: quantile(mine.map((s) => s.generation_cost_usd), 0.95),
    median_total_latency_ms: median(mine.map((s) => s.latency_total_ms)),
    p95_total_latency_ms: quantile(mine.map((s) => s.latency_total_ms), 0.95),
    median_first_chapter_ms: firstChapterStat(mine, 0.5),
    p95_first_chapter_ms: firstChapterStat(mine, 0.95),
    vs_baseline: args.contestant === args.baseline ? null : tally(vsBaseline),
    vs_best: args.contestant === args.best || vsBest.length === 0 ? null : tally(vsBest),
  }
}

function firstChapterStat(stories: BakeoffStoryRecord[], q: number): number | null {
  const values = stories
    .map((s) => s.latency_to_first_chapter_ms)
    .filter((v): v is number => typeof v === 'number')
  return values.length === 0 ? null : quantile(values, q)
}

function agreementRate(
  comparisons: BakeoffComparison[],
  secondJudgeModel: string,
): BakeoffResult['agreement'] {
  const doubled = comparisons.filter((c) => c.second_judge !== null)
  const winner = doubled.filter((c) => c.second_judge!.agrees_on_winner).length
  const criterionValues = doubled
    .map((c) => c.second_judge!.criterion_agreement)
    .filter((v) => Number.isFinite(v))
  return {
    comparisons_double_judged: doubled.length,
    winner_agreement_rate: doubled.length === 0 ? Number.NaN : winner / doubled.length,
    criterion_agreement_rate:
      criterionValues.length === 0
        ? Number.NaN
        : criterionValues.reduce((a, b) => a + b, 0) / criterionValues.length,
    second_judge_model: doubled[0]?.second_judge?.model ?? secondJudgeModel,
  }
}
