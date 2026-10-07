import {
  MAX_SCARY_LEVEL,
  type AgeBand,
  type CheckFailure,
  type FactPack,
  type GenerationRequest,
  type OutputSafetyReview,
  type OutputViolation,
  type QualityResult,
  type QualityReview,
  type StoryOutput,
  type StoryStatus,
  targetWords,
} from '@/lib/schemas'
import type { GenerationLogSink } from '@/lib/ai'
import { runDeterministicChecks, type DeterministicResult } from './deterministic'
import { measuredForReview, reviewStoryQuality, reviewFailures, reviewPassed } from './review'
import type { BlocklistData } from './blocklist'

/**
 * F7 - the quality gate.
 *
 * Order is the point: deterministic checks first and free, and a deterministic failure
 * skips the model review entirely (F7 AC). One Haiku call at most per attempt.
 *
 * Attempt 1 fail -> `rewrite` (the reasons are appended to the rewrite request).
 * Attempt 2 fail -> `flagged`: the story is still shown, with a soft banner. Never a blank
 * screen. The one exception is a HARD safety violation on the second attempt, which
 * GUARDRAILS.md §4.1 requires to be discarded instead.
 */

/**
 * The L4 safety review is lane 6's (GUARDRAILS.md §4.3) and plugs in here. Until it is
 * wired, `safety` stays null and the gate reports that in `skipped` rather than pretending
 * a safety review ran.
 */
export interface SafetyReviewer {
  review(
    story: StoryOutput,
    request: GenerationRequest,
    opts: { sink?: GenerationLogSink; storyId?: string | null; familyId?: string | null },
  ): Promise<OutputSafetyReview>
}

export interface GateOptions {
  story: unknown
  request: GenerationRequest
  factPack: FactPack | null
  /** 1 on the first pass, 2 after a rewrite. */
  attempt: 1 | 2
  sink?: GenerationLogSink
  familyId?: string | null
  storyId?: string | null
  signal?: AbortSignal
  /** Lane 6's L4 reviewer. Omitted until it exists. */
  safetyReviewer?: SafetyReviewer
  extraBlocklists?: readonly BlocklistData[]
  /** Test seam: inject a review instead of calling the model. */
  reviewOverride?: QualityReview
  /**
   * Run the model reviews even when a deterministic check failed. F7's AC skips them then,
   * to save the call - but on attempt 1 a rewrite is coming either way, and a rewrite told
   * only "22 words short" fixes the length and fails review on the vocabulary it was never
   * told about (the owner's second real story). Two Haiku calls, ~$0.01, so the one rewrite
   * the pipeline allows gets the whole list. Owner-approved 2026-09-29 (DECISIONS #138).
   */
  reviewDespiteFailures?: boolean
}

export interface GateOutcome {
  result: QualityResult
  /** What the caller should do next. */
  status: StoryStatus
  needsRewrite: boolean
  deterministic: DeterministicResult
}

function hardViolations(safety: OutputSafetyReview | null): OutputViolation[] {
  if (!safety) return []
  return safety.violations.filter((v) => v.severity === 'hard')
}

function safetyFailures(
  safety: OutputSafetyReview | null,
  band: AgeBand,
): { failures: string[]; hard: OutputViolation[] } {
  if (!safety) return { failures: [], hard: [] }
  const hard = hardViolations(safety)
  const failures: string[] = hard.map((v) => `GUARDRAILS rule ${v.rule} breached`)
  if (!safety.safe) failures.push('output safety review returned safe: false')
  if (safety.scary_level > MAX_SCARY_LEVEL[band]) {
    failures.push(`scary_level ${safety.scary_level} above band ${band} limit`)
  }
  if (!safety.positive_portrayal) failures.push('a named child is not portrayed positively')
  if (!safety.ending_safe) failures.push('the ending is not safe, warm and resolved')
  return { failures, hard }
}

export async function runQualityGate(opts: GateOptions): Promise<GateOutcome> {
  const { request, attempt } = opts
  const band = request.age_band
  const target = request.target_words ?? targetWords({ band, minutes: request.length_minutes })

  const deterministic = runDeterministicChecks({
    story: opts.story,
    children: request.children.map((c) => ({ name: c.name, age: c.age })),
    band,
    minutes: request.length_minutes,
    targetWords: target,
    factPack: opts.factPack,
    ...(opts.extraBlocklists ? { extraBlocklists: opts.extraBlocklists } : {}),
  })

  const failures: CheckFailure[] = deterministic.failures
  let review: QualityReview | null = null
  let safety: OutputSafetyReview | null = null
  let modelFailures: string[] = []
  let hard: OutputViolation[] = []

  // F7 AC: a deterministic failure skips the model review entirely - unless the caller
  // knows a rewrite follows and wants it fully briefed (see `reviewDespiteFailures`).
  const parsable = !deterministic.failures.some((f) => f.check === 'schema_valid')
  if (deterministic.passed || (opts.reviewDespiteFailures && parsable)) {
    const story = opts.story as StoryOutput
    review =
      opts.reviewOverride ??
      (await reviewStoryQuality(story, request, opts.factPack, {
        measured: measuredForReview(story, band),
        ...(opts.sink ? { sink: opts.sink } : {}),
        familyId: opts.familyId ?? null,
        storyId: opts.storyId ?? null,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }))
    modelFailures = reviewPassed(review, band) ? [] : reviewFailures(review, band)

    if (opts.safetyReviewer) {
      safety = await opts.safetyReviewer.review(story, request, {
        ...(opts.sink ? { sink: opts.sink } : {}),
        storyId: opts.storyId ?? null,
        familyId: opts.familyId ?? null,
      })
      const s = safetyFailures(safety, band)
      modelFailures = [...modelFailures, ...s.failures]
      hard = s.hard
    }
  }

  const passed = deterministic.passed && modelFailures.length === 0
  const rewriteReasons = passed
    ? []
    : [...failures.map((f) => f.detail), ...modelFailures]

  // GUARDRAILS.md §4.1: a second HARD safety breach is `discarded` here; the pipeline then
  // mends and cuts before it gives up (issue #32), and only what survives that is lost.
  const outcome: QualityResult['outcome'] = passed
    ? 'pass'
    : attempt === 1
      ? 'rewrite'
      : hard.length > 0
        ? 'discarded'
        : 'flagged'

  const result: QualityResult = {
    outcome,
    attempt,
    deterministic_passed: deterministic.passed,
    failures,
    review,
    safety,
    hard_violations: hard,
    rewrite_reasons: rewriteReasons,
    word_count: deterministic.wordCount,
    target_words: target,
  }

  return {
    result,
    status: outcome === 'pass' ? 'ready' : outcome === 'discarded' ? 'failed' : 'flagged',
    needsRewrite: outcome === 'rewrite',
    deterministic,
  }
}
