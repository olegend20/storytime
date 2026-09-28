import { z } from 'zod'

/**
 * Judge Agent contract - agents/JUDGE_AGENT.md s3/s4.
 * The judge is a tool for the owner and the team. It NEVER runs in the nightly
 * generation path (the cheap F7 gate does that) - only in `pnpm eval` / `pnpm bakeoff`.
 */

export const JUDGE_CRITERIA = [
  'center',
  'craft',
  'facts',
  'age_fit',
  'continuity',
  'delight',
] as const
export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number]

/** s3: weighted mean. Must sum to 1. */
export const JUDGE_WEIGHTS: Record<JudgeCriterion, number> = {
  center: 0.2,
  craft: 0.2,
  facts: 0.2,
  age_fit: 0.15,
  continuity: 0.1,
  delight: 0.15,
}

const Score = z.number().int().min(1).max(5)

const ScoreSet = z.object({
  center: Score,
  craft: Score,
  facts: Score,
  age_fit: Score,
  continuity: Score,
  delight: Score,
})

const EvidenceSet = z.object({
  center: z.string(),
  craft: z.string(),
  facts: z.string(),
  age_fit: z.string(),
  continuity: z.string(),
  delight: z.string(),
})

/** SCORE mode output - JUDGE_AGENT.md s4. */
export const JudgeScore = z.object({
  scores: ScoreSet,
  evidence: EvidenceSet,
  caps_applied: z.array(z.string()).default([]),
  disqualified: z.boolean(),
  overall: z.number().min(1).max(5),
  editor_notes: z.array(z.string()).max(5).default([]),
  /**
   * Verbatim excerpts the judge picks out. JUDGE_AGENT.md §6 requires three per contestant
   * in the bake-off report ("best moment" and "worst moment"). Optional because SCORE mode
   * is also used where the report isn't being built.
   */
  best_moment: z.string().max(1200).nullable().default(null),
  worst_moment: z.string().max(1200).nullable().default(null),
})
export type JudgeScore = z.infer<typeof JudgeScore>

export const Verdict = z.enum(['A', 'B', 'TIE'])
export type Verdict = z.infer<typeof Verdict>

/** PAIRWISE mode output - JUDGE_AGENT.md s4. */
export const JudgePairwise = z.object({
  per_criterion: z.object({
    center: Verdict,
    craft: Verdict,
    facts: Verdict,
    age_fit: Verdict,
    continuity: Verdict,
    delight: Verdict,
  }),
  verdict: Verdict,
  confidence: z.number().min(0.5).max(1),
  justification: z.string(),
})
export type JudgePairwise = z.infer<typeof JudgePairwise>

/** Recompute the weighted overall rather than trusting the model's arithmetic. */
export function weightedOverall(scores: z.infer<typeof ScoreSet>): number {
  let total = 0
  for (const c of JUDGE_CRITERIA) total += scores[c] * JUDGE_WEIGHTS[c]
  return Math.round(total * 100) / 100
}

/**
 * s3 automatic caps. Applied by us, not trusted to the model.
 * A guardrail breach forces overall 1 + disqualified.
 */
export function applyCaps(
  raw: JudgeScore,
  ctx: { guardrailBreach: boolean; inventedFact: boolean; wordCountOutOfRange: boolean },
): JudgeScore {
  const scores = { ...raw.scores }
  const caps: string[] = []

  if (ctx.inventedFact && scores.facts > 2) {
    scores.facts = 2
    caps.push('invented_fact:facts<=2')
  }
  if (ctx.wordCountOutOfRange && scores.age_fit > 3) {
    scores.age_fit = 3
    caps.push('word_count_out_of_range:age_fit<=3')
  }
  if (ctx.guardrailBreach) {
    caps.push('guardrail_breach:overall=1')
    return {
      ...raw,
      scores,
      caps_applied: [...raw.caps_applied.filter((c) => c !== 'none'), ...caps],
      disqualified: true,
      overall: 1,
    }
  }

  const merged = [...raw.caps_applied.filter((c) => c !== 'none'), ...caps]
  return {
    ...raw,
    scores,
    caps_applied: merged.length > 0 ? merged : ['none'],
    overall: weightedOverall(scores),
  }
}

/**
 * Position-swap resolution - JUDGE_AGENT.md s2.
 * Two runs with A/B swapped. `swapped` is the verdict from the run where the
 * contestants were presented in reverse order, already un-swapped into first-run terms.
 * Disagreement between the orders is recorded as a TIE.
 */
export function resolvePositionSwap(
  first: Verdict,
  swappedAsFirstTerms: Verdict,
): { verdict: Verdict; flipped: boolean } {
  if (first === swappedAsFirstTerms) return { verdict: first, flipped: false }
  return { verdict: 'TIE', flipped: true }
}

/** Invert a verdict reported in a swapped presentation back into first-run terms. */
export function unswap(v: Verdict): Verdict {
  if (v === 'A') return 'B'
  if (v === 'B') return 'A'
  return 'TIE'
}

/** Eval thresholds - F13 AC. Loosening these needs the owner's sign-off. */
export const EVAL_PASS_CRITERIA = {
  mean_overall_min: 4.0,
  per_scenario_min: 3.5,
  disqualified_max: 0,

  /**
   * Calibration reference thresholds (JUDGE_AGENT.md §5). Owner's decision 2026-09-28,
   * option A, replacing a flat "each >= 4.5".
   *
   * §5 scored each reference ONCE while §2 says "report medians and spreads, not single
   * samples", and the contradiction was load-bearing: the LEGO story scored 4.65 then 4.45 on
   * identical runs, so a per-story 4.5 gate passed or failed the same story on the draw. The
   * judge's measured overall spread under judge.v2 is 0.35.
   *
   * So: score each reference CALIBRATION_REPEATS times and take the median. The floor catches
   * a genuinely broken judge - one that rates these stories 3.x - while the mean catches
   * drift. Measured baseline at adoption: medians 4.65 / 4.45 / 4.40 / 4.15, mean 4.413.
   */
  calibration_repeats: 3,

  /**
   * THE GATE. A judge that rates the reference stories below 4.0 is broken, and 4.0 is a
   * principled round number rather than one fitted to a measurement.
   */
  calibration_reference_floor: 4.0,

  /**
   * REPORTED, NOT GATED - deliberately.
   *
   * The first attempt gated on "mean of medians >= 4.4", chosen because one measurement came
   * in at 4.413. The very next measurement of the same four stories with the same prompt gave
   * 4.325 and failed. The mean of four medians, each drawn from 3 samples of an instrument
   * whose overall spread is 0.35, is itself only stable to about +/-0.1 - so gating on it
   * means failing at random, and setting the number just under whatever was last observed is
   * fitting the threshold to the data.
   *
   * So the mean is recorded and compared with the baseline below, and a move beyond the
   * measured spread raises a warning for a human to look at. It does not fail the run.
   */
  calibration_baseline_mean: 4.37,
  calibration_mean_tolerance: 0.35,
} as const
