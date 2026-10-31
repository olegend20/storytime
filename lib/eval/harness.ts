import { MemoryLogSink, ModelCallError, modelForRole, type GenerationLogRow, type GenerationLogSink } from '@/lib/ai'
import {
  EVAL_PASS_CRITERIA,
  JUDGE_CRITERIA,
  MAX_SCARY_LEVEL,
  targetWords,
  wordCountWithinTolerance,
  type AgeBand,
  type JudgeScore,
} from '@/lib/schemas'
import { JUDGE_PURPOSES } from './bakeoff'
import { runCalibration, type CalibrationResult } from './calibration'
import { loadJudgePrompt, scoreStory } from './judge'
import { type FirstDraft, loadPipeline, type StoryPipeline, type StoryProvider } from './pipeline'
import { narrativeWordCount } from './render'
import { evalScenarios, scenarioBand, selectScenarios, type EvalScenario } from './scenarios'
import { fmt, mean, median, min, p95, quantile } from './stats'
import type { CapContext, JudgeContext } from './types'
import type { CloseKind } from '@/lib/ai/types'

/**
 * F13 - the quality evaluation harness behind `pnpm eval`.
 *
 * Eight fixed scenarios, generated through the real pipeline, run through the quality gate,
 * scored blind by the Judge Agent, written to `eval/results/<date>.json`, and compared
 * against the previous run.
 *
 * The gate on all of it is calibration: F13's first AC is "judge calibration set passes
 * before results count", so `runEval` runs §5 first and refuses to report scores if it
 * fails. A number produced by an uncalibrated judge is worse than no number, because it
 * looks like evidence.
 */

export interface EvalScenarioRecord {
  scenario_id: string
  why: string
  band: string
  children: { name: string; age: number }[]
  topic_key: string
  length_minutes: number
  word_count: number
  target_words: { min: number; max: number }
  word_count_in_range: boolean
  gate: {
    outcome: string
    hard_violations: number
    /** The rule numbers behind `hard_violations`, so a discarded story explains itself. */
    hard_violation_rules: number[]
    failures: string[]
    scary_level: number | null
  } | null
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
  /** F13 AC: continuity scenarios must reference a prior recurring element in chapter 1. */
  continuity_reference: { required: string[]; found: string[]; ok: boolean } | null
  /** F13 AC: the titanic scenario must pass with scary_level <= 1 for band B. */
  scary_level_check: { max: number; observed: number | null; ok: boolean | null } | null
  editor_notes: string[]
  /** Owner's hill-climb metric: the first draft went out untouched. Absent in older results. */
  first_draft?: FirstDraft | null
  generation_cost_usd: number
  judge_cost_usd: number
  /**
   * Issue #46: how long a parent waits before the story starts appearing - the number latency
   * is hill-climbed on. Null when no story was made, or the pipeline could not see it.
   */
  latency_to_first_chapter_ms: number | null
  /**
   * False when the story was made but no chapter streamed (attempt 1 died or was unusable and
   * the rewrite arrived only in `done`): the parent saw nothing until the end, so the first
   * chapter is counted at the total. Leaving it out would hide exactly the longest waits.
   */
  first_chapter_streamed: boolean
  /** Request to saved story, including the gate, any rewrite and the bible update. Null when no story was made. */
  latency_total_ms: number | null
  /** Where the time went, by call purpose. Kept for a failed story too: it shows where it died. */
  latency_by_step: Record<string, StepLatency>
  /** Issue #82: the story-so-far snapshots kept for a page that loses its stream. Live runs only. */
  progress?: { writes: number; failures: number; lag_ms: number[] }
}

/** One call purpose's share of a story's time. */
export interface StepLatency {
  calls: number
  ms: number
  /** Thinking included: the writer's thinking is most of the wait before chapter 1. */
  output_tokens: number
  /**
   * Issue #78, from each live call's stream trace. Failed calls by who ended them; our own
   * aborts (`own_abort`: the deadline, the forced-drop eval) are counted apart from real drops.
   */
  failed?: Partial<Record<CloseKind, number>>
  /** The longest silence between bytes on any one call. */
  max_gap_ms?: number
  /** `ping` events, and the streamed time they came in, for pings per minute. */
  pings?: number
  streamed_ms?: number
}

export interface LatencyStats {
  /** Scenarios that produced the number. A story that was never made has no latency. */
  n: number
  median_ms: number | null
  p95_ms: number | null
}

/**
 * Issue #46. Reported, never a pass criterion (owner's decision): one sample per scenario
 * through a remote API is too noisy to gate on. A run with no story still has no latency.
 */
export interface EvalLatencySummary {
  first_chapter: LatencyStats
  total: LatencyStats
  /** Summed over every scenario, so the step that dominates is visible at a glance. */
  by_step: Record<string, StepLatency>
  /** Stories made with no chapter streamed; their first chapter is counted at the total. */
  no_streamed_chapter: string[]
}

/** A scenario this much slower (or faster) to its first chapter than last run is flagged. */
export const LATENCY_FLAG_RATIO = 0.2

export interface EvalSummary {
  scenarios: number
  scored: number
  judge_errors: number
  /** Scenarios the API would not run (no credit, outage): not the writer's, not in the mean. */
  not_run: string[]
  mean_overall: number
  min_overall: number
  worst_scenario: string | null
  disqualified: number
  word_count_failures: string[]
  continuity_failures: string[]
  scary_level_failures: string[]
  criterion_means: Record<string, number>
  /**
   * First drafts that went out untouched, of the stories whose pipeline could tell.
   * Reported, not a pass criterion: the owner's hill-climb metric (2026-10-08).
   */
  first_draft?: { passed: number; of: number }
  passed: boolean
  failures: string[]
  /** Optional only because results written before issue #46 have none. */
  latency?: EvalLatencySummary
}

export interface EvalResult {
  version: 1
  kind: 'eval'
  ran_at: string
  date: string
  pipeline: 'live' | 'fixture'
  pipeline_describe: string
  /** True when the stories were not generated by a model. Then this is not an eval result. */
  synthetic: boolean
  judge_model: string
  judge_prompt: { version: string; sha256: string }
  calibration: CalibrationResult | { skipped: true; reason: string }
  pass_criteria: typeof EVAL_PASS_CRITERIA
  scenarios: EvalScenarioRecord[]
  summary: EvalSummary
  cost: { generation_usd: number; judge_usd: number; total_usd: number; log_rows: number }
  notes: string[]
}

export interface EvalConfig {
  /** Scenario ids, or a comma-separated spec (the `EVAL_SCENARIOS` workflow input). */
  scenarios?: string
  pipeline?: StoryPipeline
  provider?: StoryProvider
  sink?: GenerationLogSink
  skipCalibration?: boolean
  /**
   * A calibration that already passed today, to reuse instead of paying for it again
   * (≈ $1.70 of every run). Honoured only if it passed and was made with the same judge
   * prompt; otherwise calibration runs as usual.
   */
  reuseCalibration?: CalibrationResult
  /** Called the moment calibration finishes, so the result is on disk before the eval runs. */
  onCalibration?: (result: CalibrationResult) => void
  signal?: AbortSignal
  onProgress?: (line: string) => void
}

/**
 * Why a calibration result may NOT stand in for this run's, or null when it may: it must
 * have passed, today (UTC date), with the judge model `config/models.json` names now and
 * the judge prompt on disk now. JUDGE_AGENT.md §5: calibration is a property of the judge.
 */
export function calibrationReusable(
  c: CalibrationResult,
  promptSha256: string,
  now: Date = new Date(),
): string | null {
  if (!c.passed) return 'it did not pass'
  if (c.judge_prompt.sha256 !== promptSha256) return `the judge prompt changed (${c.judge_prompt.sha256} -> ${promptSha256})`
  const judge = modelForRole('judge_primary')
  if (c.judge_model !== judge) return `the judge model changed (${c.judge_model} -> ${judge})`
  if (c.ran_at.slice(0, 10) !== now.toISOString().slice(0, 10)) return `it ran on ${c.ran_at.slice(0, 10)}, not today`
  return null
}

/**
 * An error that says nothing about the writer: the API refused or failed the call itself
 * (no credit, bad key, overloaded, a 5xx, a retry budget spent). Such a scenario is
 * recorded as not run, and kept out of the mean and the disqualified count - it still fails
 * the run, since a story was not delivered.
 */
export function isInfrastructureFailure(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  // Only what the API itself says: a status the pipeline put there (`status=NNN`), or the
  // exhausted-balance phrase Anthropic sends with a plain 400. Words like "overloaded" are
  // not trusted on their own - a writer failure can quote model output that contains them.
  // The balance phrase only inside the API's own error shape, never in quoted story text.
  if (/\bstatus=(?:5\d\d|429|40[123])\b|invalid_request_error["\s\S]{0,80}credit balance is too low|status=400 [^;]*credit balance is too low/i.test(text)) return true
  if (err instanceof ModelCallError) {
    const status = err.detail.status
    // A status the API sent, and nothing else: a bare `retryable` can be a stream timeout,
    // which is a writer that ran too long, not an outage.
    return status === 401 || status === 402 || status === 403 || status === 429 || (status !== undefined && status >= 500)
  }
  return false
}

/**
 * The record for a scenario whose story was never made. The writer's doing: disqualified,
 * scored 1, nothing judged. The API's doing: not run, scored nothing.
 */
function failedRecord(
  scenario: EvalScenario,
  context: JudgeContext,
  band: AgeBand,
  reason: string,
  generationCostUsd: number,
  infrastructure: boolean,
  steps: Record<string, StepLatency>,
): EvalScenarioRecord {
  return {
    scenario_id: scenario.id,
    why: scenario.why,
    band,
    children: scenario.children.map((c) => ({ name: c.name, age: c.age })),
    topic_key: scenario.topic_key,
    length_minutes: scenario.length_minutes,
    word_count: 0,
    target_words: context.target_words,
    word_count_in_range: false,
    gate: null,
    judge_ok: false,
    judge_error: `${infrastructure ? 'not run' : 'no story'}: ${reason}`,
    scores_raw: null,
    overall_raw: null,
    overall_final: infrastructure ? null : 1,
    caps_applied: infrastructure ? ['not_run:infrastructure'] : ['no_story:overall=1'],
    disqualified: !infrastructure,
    cap_context: null,
    best_moment: null,
    worst_moment: null,
    continuity_reference: null,
    scary_level_check: null,
    editor_notes: [],
    generation_cost_usd: generationCostUsd,
    judge_cost_usd: 0,
    latency_to_first_chapter_ms: null,
    first_chapter_streamed: false,
    latency_total_ms: null,
    latency_by_step: steps,
  }
}

/** The generation calls in `rows`, grouped by purpose. Judging is the eval's, not the story's. */
export function stepLatency(rows: readonly GenerationLogRow[]): Record<string, StepLatency> {
  const steps: Record<string, StepLatency> = {}
  for (const r of rows) {
    if (JUDGE_PURPOSES.has(r.purpose)) continue
    const step = (steps[r.purpose] ??= { calls: 0, ms: 0, output_tokens: 0 })
    step.calls += 1
    step.ms += r.latency_ms
    step.output_tokens += r.output_tokens
    if (r.stream) addTrace(step, r.stream)
  }
  return steps
}

function addTrace(step: StepLatency, t: { close: CloseKind | null; max_gap_ms: number; events: Record<string, number>; elapsed_ms: number }): void {
  if (t.close) {
    const failed = (step.failed ??= {})
    failed[t.close] = (failed[t.close] ?? 0) + 1
  }
  step.max_gap_ms = Math.max(step.max_gap_ms ?? 0, t.max_gap_ms)
  step.pings = (step.pings ?? 0) + (t.events.ping ?? 0)
  step.streamed_ms = (step.streamed_ms ?? 0) + t.elapsed_ms
}

/** Issue #78: real drops (not our own aborts) by who ended them, and the longest silence, per purpose. */
export function dropsLine(byStep: Record<string, StepLatency>): string | null {
  const parts: string[] = []
  for (const [purpose, st] of Object.entries(byStep).sort(([a], [b]) => a.localeCompare(b))) {
    if (st.max_gap_ms === undefined) continue
    const failed = Object.entries(st.failed ?? {}) as [CloseKind, number][]
    const real = failed.filter(([k]) => k !== 'own_abort').reduce((n, [, v]) => n + v, 0)
    const own = st.failed?.own_abort ?? 0
    const kinds = failed.filter(([k]) => k !== 'own_abort').map(([k, v]) => `${k} ${v}`).join(', ')
    const perMin = st.streamed_ms ? ((st.pings ?? 0) / (st.streamed_ms / 60_000)).toFixed(1) : '0.0'
    parts.push(
      `${purpose} ${real}/${st.calls} dropped${kinds ? ` (${kinds})` : ''}${own ? `, ${own} own abort(s)` : ''}, ` +
        `longest silence ${(st.max_gap_ms / 1000).toFixed(1)}s, ${perMin} pings/min`,
    )
  }
  return parts.length > 0 ? `  drops (issue #78): ${parts.join('; ')}` : null
}

/**
 * Issue #82: did the story-so-far keep up with the story? Snapshots per story, the lag from an
 * event to its snapshot being stored (what a returning page can be behind by), and failures.
 */
export function progressLine(records: readonly { progress?: { writes: number; failures: number; lag_ms: number[] } }[]): string | null {
  const kept = records.flatMap((r) => (r.progress ? [r.progress] : []))
  if (kept.length === 0) return null
  const lags = kept.flatMap((p) => p.lag_ms)
  const writes = kept.reduce((n, p) => n + p.writes, 0)
  const failures = kept.reduce((n, p) => n + p.failures, 0)
  const perStory = median(kept.map((p) => p.writes))
  const ms = (q: number) => (lags.length > 0 ? `${Math.round(quantile(lags, q))} ms` : '-')
  return (
    `  progress (issue #82): ${kept.length} stories, ${writes} snapshots (median ${perStory} per story), ` +
    `lag p50 ${ms(0.5)}, p95 ${ms(0.95)}, ${failures} write failure(s)`
  )
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

const NO_PROGRESS = (): void => {}

export async function runEval(config: EvalConfig = {}): Promise<EvalResult> {
  const progress = config.onProgress ?? NO_PROGRESS
  const scenarios = selectScenarios(evalScenarios(), config.scenarios)
  const sink = config.sink ?? new MemoryLogSink()
  const prompt = loadJudgePrompt()

  let calibration: EvalResult['calibration']
  if (config.skipCalibration) {
    calibration = {
      skipped: true,
      reason:
        'skipCalibration was set. F13 AC requires calibration to pass before results count; ' +
        'a result with this flag set is a harness test, not an eval result.',
    }
  } else if (config.reuseCalibration && calibrationReusable(config.reuseCalibration, prompt.sha256) === null) {
    progress(`Reusing the calibration from ${config.reuseCalibration.ran_at} (same day, judge and prompt)`)
    calibration = {
      ...config.reuseCalibration,
      // Paid for by the earlier run, not this one.
      cost_usd: 0,
      judge_calls: 0,
      notes: [...config.reuseCalibration.notes, 'reused from an earlier run today'],
    }
  } else {
    if (config.reuseCalibration) {
      progress(`Not reusing the calibration offered: ${calibrationReusable(config.reuseCalibration, prompt.sha256)}`)
    }
    progress('Running judge calibration (JUDGE_AGENT.md §5)…')
    calibration = await runCalibration({ sink, ...(config.signal ? { signal: config.signal } : {}) })
    config.onCalibration?.(calibration)
    if (!calibration.passed) {
      const failed = calibration.expectations.filter((e) => !e.passed).map((e) => e.id)
      throw new Error(
        `Judge calibration failed (${failed.join(', ')}).\n` +
          `F13 AC: results do not count until calibration passes. JUDGE_AGENT.md §5: fix the ` +
          `judge prompt, never the reference stories.\n` +
          `No eval scores were produced.`,
      )
    }
  }

  const pipeline =
    config.pipeline ??
    (await loadPipeline(config.provider ? { mode: 'fixture', provider: config.provider } : {}))
  const writingModel = modelForRole('writer')

  const records: EvalScenarioRecord[] = []
  let judgeModel = ''

  for (const scenario of scenarios) {
    const context = judgeContextFor(scenario)
    const band = scenarioBand(scenario)
    const storyId = `eval:${scenario.id}`
    progress(`generate ${scenario.id}`)
    let generated: Awaited<ReturnType<StoryPipeline['generate']>>
    // Where this scenario's log rows start, so a failure can count what it spent: the live
    // pipeline tags its rows with the story's own uuid, not with `storyId` here.
    const rowsBefore = 'rows' in sink ? (sink as MemoryLogSink).rows.length : 0
    try {
      generated = await pipeline.generate({
        scenario,
        writingModel,
        sample: 1,
        sink,
        storyId,
        ...(config.signal ? { signal: config.signal } : {}),
      })
    } catch (err) {
      // A story that could not be made IS a result - the worst one - not a reason to throw
      // away the rest of a paid run (eval-2026-10-06 died on scenario 2 of 8 this way).
      if (config.signal?.aborted) throw err
      const reason = err instanceof Error ? err.message : String(err)
      const infrastructure = isInfrastructureFailure(err)
      progress(`no story for ${scenario.id}${infrastructure ? ' (not the writer: the API)' : ''}: ${reason}`)
      // What it cost before it failed (the write, a repair) is still money spent. Counted from
      // the rows a recording sink holds (MemoryLogSink and MeteredLogSink, which every caller
      // uses); a sink that keeps no rows reports 0 here, and the run's cost block still has it.
      const spent =
        'rows' in sink
          ? (sink as MemoryLogSink).rows
              .slice(rowsBefore)
              .filter((r) => !JUDGE_PURPOSES.has(r.purpose))
              .reduce((n, r) => n + r.cost_usd, 0)
          : 0
      records.push(
        failedRecord(scenario, context, band, reason, round6(spent), infrastructure, stepLatency(rowsSince(sink, rowsBefore))),
      )
      continue
    }

    // Taken before scoring, so the judge's calls are not in the story's steps.
    const steps = stepLatency(rowsSince(sink, rowsBefore))
    progress(`score ${scenario.id}`)
    const scored = await scoreStory({
      context,
      story: generated.story,
      gate: generated.gate,
      factPack: generated.factPack,
      sink,
      storyId,
      ...(config.signal ? { signal: config.signal } : {}),
    })
    if (scored.model) judgeModel = scored.model

    const words = narrativeWordCount(generated.story)
    const chapterOne = generated.story.chapters[0]?.text ?? ''
    const required = scenario.checks.continuity_reference ?? null
    const found = required ? required.filter((needle) => mentions(chapterOne, needle)) : []
    const scaryMax = scenario.checks.max_scary_level ?? MAX_SCARY_LEVEL[band]
    const observedScary = generated.gate?.scary_level ?? null

    records.push({
      scenario_id: scenario.id,
      why: scenario.why,
      band,
      children: scenario.children.map((c) => ({ name: c.name, age: c.age })),
      topic_key: scenario.topic_key,
      length_minutes: scenario.length_minutes,
      word_count: words,
      target_words: context.target_words,
      word_count_in_range: wordCountWithinTolerance(words, context.target_words),
      gate: generated.gate
        ? {
            outcome: generated.gate.outcome ?? 'unknown',
            hard_violations: generated.gate.hard_violations?.length ?? 0,
            hard_violation_rules: (generated.gate.hard_violations ?? []).map((v) => v.rule),
            failures: (generated.gate.failures ?? []).map((f) => f.check),
            scary_level: observedScary,
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
      continuity_reference: required
        ? { required, found, ok: found.length > 0 }
        : null,
      scary_level_check:
        scenario.checks.max_scary_level === undefined
          ? null
          : {
              max: scaryMax,
              observed: observedScary,
              // Null, not true: the gate has not run, so this is unverified rather than passed.
              ok: observedScary === null ? null : observedScary <= scaryMax,
            },
      editor_notes: scored.ok ? scored.final.editor_notes : [],
      first_draft: generated.firstDraft ?? null,
      generation_cost_usd: generated.costUsd,
      judge_cost_usd: scored.costUsd,
      latency_to_first_chapter_ms: generated.latency.toFirstChapterMs ?? generated.latency.totalMs,
      first_chapter_streamed: generated.latency.toFirstChapterMs !== null,
      latency_total_ms: generated.latency.totalMs,
      latency_by_step: steps,
      ...(generated.progress
        ? { progress: { writes: generated.progress.writes, failures: generated.progress.failures, lag_ms: generated.progress.lagMs } }
        : {}),
    })
  }

  const summary = summarize(records)
  const rows = 'rows' in sink ? (sink as MemoryLogSink).rows : []
  const generationUsd = round6(records.reduce((n, r) => n + r.generation_cost_usd, 0))
  const judgeFromScores = records.reduce((n, r) => n + r.judge_cost_usd, 0)
  const calibrationCost = 'cost_usd' in calibration ? calibration.cost_usd : 0
  const judgeUsd = round6(judgeFromScores + calibrationCost)

  const notes = [
    'Judge payloads are checked blind before every call (lib/eval/blind.ts); the judge never saw a model id.',
    'The weighted overall and the automatic caps are recomputed in our code, not taken from the judge (DECISIONS.md #11/#12).',
  ]
  if (pipeline.kind === 'fixture') {
    notes.push(
      'PIPELINE: FIXTURE. These stories were not generated by a model, so the scores describe the harness, not the product. Not an eval result.',
    )
  }
  if (records.some((r) => r.cap_context?.factSourcing === 'unverifiable_no_fact_pack')) {
    notes.push(
      'Some scenarios had no fact pack, so the `unsourced_fact` check could not run and is recorded as unverifiable rather than passed.',
    )
  }
  if (records.some((r) => r.gate === null)) {
    notes.push(
      'Some scenarios have no F7 gate result, so guardrail-breach detection rested on the judge alone.',
    )
  }
  const unverifiedScary = records
    .filter((r) => r.scary_level_check !== null && r.scary_level_check.ok === null)
    .map((r) => r.scenario_id)
  if (unverifiedScary.length > 0) {
    notes.push(
      `The scary-level checks are UNVERIFIED, not passed, for ${unverifiedScary.join(', ')}: ` +
        `the gate reported no scary_level. F13's "the-titanic passes with scary_level <= 1" AC ` +
        `cannot be met until F7 emits one.`,
    )
  }

  return {
    version: 1,
    kind: 'eval',
    ran_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    pipeline: pipeline.kind,
    pipeline_describe: pipeline.describe,
    synthetic: pipeline.kind === 'fixture',
    judge_model: judgeModel || modelForRole('judge_primary'),
    judge_prompt: { version: prompt.version, sha256: prompt.sha256 },
    calibration,
    pass_criteria: EVAL_PASS_CRITERIA,
    scenarios: records,
    summary,
    cost: {
      generation_usd: generationUsd,
      judge_usd: judgeUsd,
      total_usd: round6(generationUsd + judgeUsd),
      log_rows: rows.filter((r) => !JUDGE_PURPOSES.has(r.purpose)).length,
    },
    notes,
  }
}

function rowsSince(sink: GenerationLogSink, from: number): GenerationLogRow[] {
  return 'rows' in sink ? (sink as MemoryLogSink).rows.slice(from) : []
}

function latencyStats(values: (number | null)[]): LatencyStats {
  const known = values.filter((v): v is number => v !== null)
  if (known.length === 0) return { n: 0, median_ms: null, p95_ms: null }
  return { n: known.length, median_ms: Math.round(median(known)), p95_ms: Math.round(p95(known)) }
}

export function summarizeLatency(records: EvalScenarioRecord[]): EvalLatencySummary {
  const byStep: Record<string, StepLatency> = {}
  for (const r of records) {
    for (const [purpose, step] of Object.entries(r.latency_by_step)) {
      const sum = (byStep[purpose] ??= { calls: 0, ms: 0, output_tokens: 0 })
      sum.calls += step.calls
      sum.ms += step.ms
      sum.output_tokens += step.output_tokens
      if (step.max_gap_ms !== undefined) {
        for (const [k, v] of Object.entries(step.failed ?? {}) as [CloseKind, number][]) {
          const failed = (sum.failed ??= {})
          failed[k] = (failed[k] ?? 0) + v
        }
        sum.max_gap_ms = Math.max(sum.max_gap_ms ?? 0, step.max_gap_ms)
        sum.pings = (sum.pings ?? 0) + (step.pings ?? 0)
        sum.streamed_ms = (sum.streamed_ms ?? 0) + (step.streamed_ms ?? 0)
      }
    }
  }
  return {
    first_chapter: latencyStats(records.map((r) => r.latency_to_first_chapter_ms)),
    total: latencyStats(records.map((r) => r.latency_total_ms)),
    by_step: byStep,
    no_streamed_chapter: records
      .filter((r) => r.latency_total_ms !== null && !r.first_chapter_streamed)
      .map((r) => r.scenario_id),
  }
}

/**
 * Whole words only: a substring match let 'Bit' pass on "bite" and "rabbit", and 'coin' on
 * "coincidence", so a dinosaur story could not fail its continuity check (issue #48 review).
 * A short capitalised name ('Bit') is also matched case-sensitively, or "a bit" would still
 * pass; longer needles stay case-insensitive, as they always were ("Play well", "play well").
 * A plural still counts - "golden coins" for 'coin', "red bricks" for 'red brick' - as it did
 * under the substring match (reviewer on #49).
 */
export function mentions(text: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const flags = /^[A-Z][a-z]{0,3}$/.test(needle) ? '' : 'i'
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:s|es)?(?![\\p{L}\\p{N}])`, `u${flags}`).test(text)
}

/** True when two runs scored exactly the same stories, so their deltas mean something. */
export function sameScenarios(a: EvalResult, b: EvalResult): boolean {
  const ids = (r: EvalResult) => r.scenarios.map((s) => s.scenario_id).sort().join(',')
  return ids(a) === ids(b)
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

export function summarize(records: EvalScenarioRecord[]): EvalSummary {
  const scored = records.filter((r) => r.overall_final !== null)
  const overalls = scored.map((r) => r.overall_final!)
  const worst = [...scored].sort((a, b) => a.overall_final! - b.overall_final!)[0] ?? null

  const criterionMeans: Record<string, number> = {}
  for (const crit of JUDGE_CRITERIA) {
    criterionMeans[crit] = mean(scored.filter((r) => r.scores_raw).map((r) => r.scores_raw![crit]))
  }

  // A story that was never written has no word count to be out of range.
  const neverWritten = (r: EvalScenarioRecord) => r.caps_applied.some((c) => c.startsWith('no_story') || c.startsWith('not_run'))
  const wordFailures = records.filter((r) => !neverWritten(r) && !r.word_count_in_range).map((r) => r.scenario_id)
  const continuityFailures = records
    .filter((r) => r.continuity_reference && !r.continuity_reference.ok)
    .map((r) => r.scenario_id)
  const scaryFailures = records
    .filter((r) => r.scary_level_check && r.scary_level_check.ok === false)
    .map((r) => r.scenario_id)
  const disqualified = records.filter((r) => r.disqualified).length
  const notRun = records.filter((r) => r.caps_applied.includes('not_run:infrastructure')).map((r) => r.scenario_id)
  // A judge error is a judge call that failed; a story that was never made made no call.
  const judgeErrors = records.filter((r) => !r.judge_ok && r.caps_applied.length === 0).length

  const meanOverall = mean(overalls)
  const minOverall = min(overalls)

  const failures: string[] = []
  if (judgeErrors > 0) failures.push(`${judgeErrors} scenario(s) returned judge_error`)
  if (notRun.length > 0) failures.push(`not run (the API, not the writer): ${notRun.join(', ')}`)
  if (!(meanOverall >= EVAL_PASS_CRITERIA.mean_overall_min)) {
    failures.push(`mean overall ${fmt(meanOverall)} < ${EVAL_PASS_CRITERIA.mean_overall_min}`)
  }
  if (!(minOverall >= EVAL_PASS_CRITERIA.per_scenario_min)) {
    failures.push(
      `lowest scenario ${fmt(minOverall)} (${worst?.scenario_id ?? '?'}) < ${EVAL_PASS_CRITERIA.per_scenario_min}`,
    )
  }
  if (disqualified > EVAL_PASS_CRITERIA.disqualified_max) {
    failures.push(`${disqualified} disqualified story(s)`)
  }
  if (wordFailures.length > 0) failures.push(`word count out of range: ${wordFailures.join(', ')}`)
  if (continuityFailures.length > 0) {
    failures.push(`no prior recurring element in chapter 1: ${continuityFailures.join(', ')}`)
  }
  if (scaryFailures.length > 0) failures.push(`scary level above the band limit: ${scaryFailures.join(', ')}`)

  return {
    scenarios: records.length,
    scored: scored.length,
    judge_errors: judgeErrors,
    not_run: notRun,
    mean_overall: Math.round(meanOverall * 100) / 100,
    min_overall: Math.round(minOverall * 100) / 100,
    worst_scenario: worst?.scenario_id ?? null,
    disqualified,
    word_count_failures: wordFailures,
    continuity_failures: continuityFailures,
    scary_level_failures: scaryFailures,
    criterion_means: criterionMeans,
    first_draft: {
      passed: records.filter((r) => r.first_draft?.passed === true).length,
      of: records.filter((r) => r.first_draft != null).length,
    },
    passed: failures.length === 0,
    failures,
    // Never in `failures`: latency is reported, not gated (issue #46).
    latency: summarizeLatency(records),
  }
}

/** F13: "prints a comparison against the previous run." */
export function compareEvalRuns(current: EvalResult, previous: EvalResult | null): string {
  const lines: string[] = []
  if (!previous) {
    lines.push('No previous run in eval/results/ to compare against; this is the baseline.')
    return lines.join('\n')
  }

  lines.push(`Comparison against ${previous.date} (${previous.scenarios.length} scenarios)`)
  if (!sameScenarios(current, previous)) {
    lines.push(
      `  ! different stories (${current.scenarios.length} now, ${previous.scenarios.length} then): the mean and ` +
        `lowest deltas compare different sets, so they are not a before/after. Compare like with like.`,
    )
  }
  if (previous.judge_prompt.sha256 !== current.judge_prompt.sha256) {
    lines.push(
      `  ! judge prompt changed (${previous.judge_prompt.sha256} -> ${current.judge_prompt.sha256}). ` +
        `Scores are not directly comparable across a prompt change; CLAUDE.md rule 5 wants the ` +
        `before/after in the PR either way.`,
    )
  }
  if (previous.pipeline !== current.pipeline) {
    lines.push(`  ! pipeline changed (${previous.pipeline} -> ${current.pipeline})`)
  }

  const delta = (now: number, before: number): string => {
    const d = now - before
    const sign = d > 0 ? '+' : ''
    return `${fmt(now)} (${sign}${fmt(d)})`
  }
  lines.push(`  mean overall: ${delta(current.summary.mean_overall, previous.summary.mean_overall)}`)
  lines.push(`  lowest scenario: ${delta(current.summary.min_overall, previous.summary.min_overall)}`)
  lines.push(
    `  disqualified: ${current.summary.disqualified} (was ${previous.summary.disqualified})`,
  )
  const drafts = (s: EvalSummary): string => (s.first_draft ? `${s.first_draft.passed}/${s.first_draft.of}` : 'not recorded')
  lines.push(`  first drafts untouched: ${drafts(current.summary)} (was ${drafts(previous.summary)})`)

  const before = new Map(previous.scenarios.map((s) => [s.scenario_id, s]))
  for (const s of current.scenarios) {
    const prior = before.get(s.scenario_id)
    if (!prior || s.overall_final === null || prior.overall_final === null) {
      lines.push(`  ${s.scenario_id}: ${s.overall_final === null ? 'judge_error' : fmt(s.overall_final)} (new)`)
      continue
    }
    const d = s.overall_final - prior.overall_final
    const marker = d <= -0.3 ? ' <- regression' : d >= 0.3 ? ' <- improvement' : ''
    lines.push(`  ${s.scenario_id}: ${delta(s.overall_final, prior.overall_final)}${marker}`)
  }
  const gone = previous.scenarios.filter((p) => !current.scenarios.some((s) => s.scenario_id === p.scenario_id))
  for (const p of gone) lines.push(`  ${p.scenario_id}: not run this time (was ${fmt(p.overall_final ?? Number.NaN)})`)

  lines.push(...compareLatency(current, previous))
  return lines.join('\n')
}

/** Issue #46: the latency half of the comparison. Flags, never fails. */
function compareLatency(current: EvalResult, previous: EvalResult): string[] {
  const lines = ['', '  Latency (time to first chapter is the number to climb)']
  const before = previous.summary.latency
  const now = current.summary.latency
  if (!before || !now) {
    lines.push('  no latency baseline: the previous run predates latency reporting (issue #46)')
    return lines
  }
  const change = (cur: number | null, prev: number | null): string => {
    if (cur === null) return '-'
    if (prev === null || prev === 0) return `${secs(cur)} (no baseline)`
    const d = cur - prev
    const pct = Math.round((d / prev) * 100)
    return `${secs(cur)} (${d > 0 ? '+' : ''}${secs(d)}, ${pct > 0 ? '+' : ''}${pct}%)`
  }
  lines.push(`  first chapter, median: ${change(now.first_chapter.median_ms, before.first_chapter.median_ms)}`)
  lines.push(`  total, median: ${change(now.total.median_ms, before.total.median_ms)}`)
  if (now.no_streamed_chapter.length > 0) {
    lines.push(`  ! no chapter streamed (first chapter counted at the total): ${now.no_streamed_chapter.join(', ')}`)
  }

  const prior = new Map(previous.scenarios.map((s) => [s.scenario_id, s]))
  for (const s of current.scenarios) {
    const cur = s.latency_to_first_chapter_ms
    const before = prior.get(s.scenario_id)
    const prev = before?.latency_to_first_chapter_ms ?? null
    if (cur === null || prev === null || prev === 0) continue
    const ratio = (cur - prev) / prev
    // Streamed in one run and not the other: the two numbers are counted differently, so a
    // jump between them is not a change in speed and is not flagged as one.
    const switched = before?.first_chapter_streamed !== undefined && before.first_chapter_streamed !== s.first_chapter_streamed
    const marker = switched
      ? ' (no stream in one run, not compared)'
      : ratio >= LATENCY_FLAG_RATIO ? ' <- latency regression' : ratio <= -LATENCY_FLAG_RATIO ? ' <- latency improvement' : ''
    lines.push(`  ${s.scenario_id}: first chapter ${change(cur, prev)}${marker}`)
  }
  return lines
}

function secs(ms: number | null): string {
  return ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`
}

/** Console summary for `pnpm eval`. */
export function formatEval(result: EvalResult): string {
  const lines: string[] = []
  lines.push(`Eval (F13) - ${result.summary.passed ? 'PASS' : 'FAIL'}`)
  lines.push(
    `  pipeline: ${result.pipeline} (${result.pipeline_describe})${result.synthetic ? '  ** SYNTHETIC: not an eval result **' : ''}`,
  )
  lines.push(`  judge: ${result.judge_model}  prompt: ${result.judge_prompt.version}@${result.judge_prompt.sha256}`)
  lines.push(
    `  mean overall ${fmt(result.summary.mean_overall)} (need >= ${EVAL_PASS_CRITERIA.mean_overall_min}), ` +
      `lowest ${fmt(result.summary.min_overall)} (need >= ${EVAL_PASS_CRITERIA.per_scenario_min})`,
  )
  if (result.summary.first_draft && result.summary.first_draft.of > 0) {
    lines.push(`  first drafts untouched: ${result.summary.first_draft.passed}/${result.summary.first_draft.of}`)
  }
  lines.push('')
  lines.push('  scenario                        band  words  target       overall  1st ch   total    caps')
  for (const s of result.scenarios) {
    lines.push(
      `  ${s.scenario_id.padEnd(30)}  ${s.band.padEnd(4)}  ${String(s.word_count).padEnd(5)}  ` +
        `${`${s.target_words.min}-${s.target_words.max}`.padEnd(11)}  ` +
        `${(s.overall_final === null ? 'ERR' : fmt(s.overall_final)).padEnd(7)}  ` +
        `${secs(s.latency_to_first_chapter_ms).padEnd(7)}  ${secs(s.latency_total_ms).padEnd(7)}  ` +
        `${s.caps_applied.join(',') || 'none'}`,
    )
    const fd = s.first_draft
    if (fd && !fd.passed) {
      const why = [...fd.failures, ...fd.mended_rules.map((r) => `mended rule ${r}`), ...fd.reasons.slice(0, 1)].join(', ')
      lines.push(`    first draft sent back: ${(why || 'retried').slice(0, 160)}`)
    }
  }
  lines.push('')
  const latency = result.summary.latency
  if (latency) {
    lines.push(
      `  latency (reported, not a pass criterion): first chapter median ${secs(latency.first_chapter.median_ms)}, ` +
        `p95 ${secs(latency.first_chapter.p95_ms)}; total median ${secs(latency.total.median_ms)}, ` +
        `p95 ${secs(latency.total.p95_ms)} (${latency.total.n} stories)`,
    )
    if (latency.no_streamed_chapter.length > 0) {
      lines.push(`  no chapter streamed, first chapter counted at the total: ${latency.no_streamed_chapter.join(', ')}`)
    }
    const steps = Object.entries(latency.by_step).sort(([, a], [, b]) => b.ms - a.ms)
    const all = steps.reduce((n, [, st]) => n + st.ms, 0)
    if (all > 0) {
      lines.push(
        '  where the time went: ' +
          steps
            .map(([purpose, st]) => `${purpose} ${Math.round((st.ms / all) * 100)}% (${st.calls} calls, ${st.output_tokens} out tok)`)
            .join(', '),
      )
    }
    const drops = dropsLine(latency.by_step)
    if (drops) lines.push(drops)
    const progress = progressLine(result.scenarios)
    if (progress) lines.push(progress)
    lines.push('')
  }
  if (result.summary.failures.length > 0) {
    lines.push('  Failures:')
    for (const f of result.summary.failures) lines.push(`    - ${f}`)
  }
  for (const n of result.notes) lines.push(`  note: ${n}`)
  lines.push(
    `  cost: ${result.cost.total_usd.toFixed(4)} USD (${result.cost.generation_usd.toFixed(4)} generation + ${result.cost.judge_usd.toFixed(4)} judging)`,
  )
  return lines.join('\n')
}
