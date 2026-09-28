import type { AgeBand } from '@/lib/schemas/common'
import { MAX_SCARY_LEVEL } from '@/lib/schemas/common'
import type { OutputSafetyReview, OutputViolation } from '@/lib/schemas/guardrail'
import type { CheckFailure } from '@/lib/schemas/quality'
import type { StoryOutput } from '@/lib/schemas/story'
import { storyText } from '@/lib/schemas/story'
import { HARD_RULE_TEXT } from './prompt'
import { scanStoryStructure } from './output'
import { reviewOutput, type ReviewInput } from './review'
import { outputFailureMessage } from './messages'

/**
 * The L4 output gate, assembled - GUARDRAILS.md s4.
 *
 * F7 (lane 2) owns the quality gate; this is the safety half it calls. Deterministic
 * checks run first and for free, and a hard deterministic violation skips the model
 * review entirely (s1.2 / F7 AC).
 *
 * s4.1: "any breach fails the story and triggers a rewrite; a second breach -> story
 * discarded, parent sees 'we couldn't make a good story about that tonight', quota not
 * consumed."
 */

export type SafetyOutcome = 'pass' | 'rewrite' | 'discard'

export interface OutputGateInput {
  story: StoryOutput
  band: AgeBand
  childNames: string[]
  knownOtherNames?: string[]
  extraAllowed?: string[]
  /** 1 on the first pass, 2 on the story written after a rewrite request. */
  attempt: 1 | 2
  familyId?: string | null
  storyId?: string | null
  sink?: ReviewInput['sink']
  signal?: AbortSignal
  /** Test seam: supply a review function instead of calling Haiku. */
  review?: (input: ReviewInput) => Promise<{ review: OutputSafetyReview; costUsd: number }>
}

export interface OutputGateResult {
  outcome: SafetyOutcome
  passed: boolean
  hardViolations: OutputViolation[]
  softViolations: OutputViolation[]
  failures: CheckFailure[]
  review: OutputSafetyReview | null
  /** Reasons to append to the rewrite request (F6 `GenerationRequest.rewrite_reasons`). */
  rewriteReasons: string[]
  /** Copy for the parent when the outcome is `discard`. Null otherwise. */
  parentMessage: string | null
  costUsd: number
  /** True when the deterministic layer failed the story and no model call was made. */
  skippedReview: boolean
}

function reasonFor(v: OutputViolation): string {
  const rule = HARD_RULE_TEXT[v.rule]
  const quote = v.quote.trim() === '' ? '' : ` Offending text: "${v.quote.slice(0, 160)}".`
  return `Rule ${v.rule} was broken. ${rule ?? ''}${quote} Rewrite so this does not happen.`
}

export async function runOutputGate(input: OutputGateInput): Promise<OutputGateResult> {
  const structure = scanStoryStructure(input.story, {
    childNames: input.childNames,
    ...(input.knownOtherNames ? { knownOtherNames: input.knownOtherNames } : {}),
    ...(input.extraAllowed ? { extraAllowed: input.extraAllowed } : {}),
  })

  const hard = structure.violations.filter((v) => v.severity === 'hard')
  const soft = structure.violations.filter((v) => v.severity === 'soft')

  const finish = (
    hardViolations: OutputViolation[],
    review: OutputSafetyReview | null,
    costUsd: number,
    skippedReview: boolean,
  ): OutputGateResult => {
    const failed = hardViolations.length > 0
    const outcome: SafetyOutcome = !failed ? 'pass' : input.attempt >= 2 ? 'discard' : 'rewrite'
    return {
      outcome,
      passed: !failed,
      hardViolations,
      softViolations: soft,
      failures: structure.failures,
      review,
      rewriteReasons: outcome === 'rewrite' ? hardViolations.map(reasonFor) : [],
      parentMessage: outcome === 'discard' ? outputFailureMessage() : null,
      costUsd,
      skippedReview,
    }
  }

  // Cheap layer first: a deterministic hard violation needs no model call.
  if (hard.length > 0) return finish(hard, null, 0, true)

  const reviewInput: ReviewInput = {
    storyText: storyText(input.story),
    band: input.band,
    childNames: input.childNames,
    hints: soft,
    familyId: input.familyId ?? null,
    storyId: input.storyId ?? null,
    ...(input.sink ? { sink: input.sink } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }
  const { review, costUsd } = await (input.review ?? reviewOutput)(reviewInput)

  // s4.3: any hard violation, scary_level above the band limit, positive_portrayal false
  // or ending_safe false -> fail.
  const modelHard = review.violations.filter((v) => v.severity === 'hard')
  const derived: OutputViolation[] = [...modelHard]
  if (review.scary_level > MAX_SCARY_LEVEL[input.band]) {
    derived.push({
      rule: 3,
      quote: `scary_level ${review.scary_level} exceeds band ${input.band} limit ${MAX_SCARY_LEVEL[input.band]}`,
      severity: 'hard',
    })
  }
  if (!review.positive_portrayal) {
    derived.push({ rule: 13, quote: 'positive_portrayal: false', severity: 'hard' })
  }
  if (!review.ending_safe) {
    derived.push({ rule: 14, quote: 'ending_safe: false', severity: 'hard' })
  }
  if (!review.safe && derived.length === 0) {
    derived.push({ rule: 1, quote: 'safety review returned safe: false', severity: 'hard' })
  }

  return finish(derived, review, costUsd, false)
}
