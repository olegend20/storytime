import { z } from 'zod'

/**
 * Judge Agent contract - agents/JUDGE_AGENT.md s3/s4.
 * The judge is a tool for the owner and the team. It NEVER runs in the nightly
 * generation path (the cheap F7 gate does that) - only in `pnpm eval` / `pnpm bakeoff`.
 */

export const JUDGE_CRITERIA = [
  'heroes',
  'craft',
  'facts',
  'age_fit',
  'continuity',
  'delight',
] as const
export type JudgeCriterion = (typeof JUDGE_CRITERIA)[number]

/** s3: weighted mean. Must sum to 1. */
export const JUDGE_WEIGHTS: Record<JudgeCriterion, number> = {
  heroes: 0.2,
  craft: 0.2,
  facts: 0.2,
  age_fit: 0.15,
  continuity: 0.1,
  delight: 0.15,
}

const Score = z.number().int().min(1).max(5)

const ScoreSet = z.object({
  heroes: Score,
  craft: Score,
  facts: Score,
  age_fit: Score,
  continuity: Score,
  delight: Score,
})

const EvidenceSet = z.object({
  heroes: z.string(),
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
    heroes: Verdict,
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
  calibration_reference_min: 4.5,
} as const
