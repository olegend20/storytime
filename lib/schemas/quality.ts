import { z } from 'zod'
import { OutputSafetyReview, OutputViolation } from './guardrail'

/**
 * Quality gate contract - IMPLEMENTATION_PLAN.md F7 + GUARDRAILS.md s4.
 * Deterministic checks run FIRST and for free; a deterministic failure skips the
 * Haiku review entirely (F7 AC).
 */

/** Stable machine-readable reason codes. Tests assert on these, not on prose. */
export const DeterministicCheck = z.enum([
  'schema_valid',
  'word_count_in_range',
  'child_missing',
  'child_name_coverage',
  'child_has_action',
  'true_facts_count',
  'unsourced_fact',
  'fact_min_age',
  'fact_not_kid_safe',
  'ending_line_present',
  'banned_word',
  'chapter_word_share',
  'cliffhanger_marker',
  'contains_url_or_contact',
  'meta_content',
  'unknown_child_name',
  /** Measured against the band's limits in config/bands.json (lib/bands.ts). */
  'sentence_length',
  /** A bold term in the True Facts list that the story itself never used. */
  'true_fact_not_in_story',
])
export type DeterministicCheck = z.infer<typeof DeterministicCheck>

export const CheckFailure = z.object({
  check: DeterministicCheck,
  /** e.g. "child_missing:Juno" - the detail the VTs match on. */
  detail: z.string().max(300),
})
export type CheckFailure = z.infer<typeof CheckFailure>

/** Haiku quality review (F7). Distinct from the L4 safety review in guardrail.ts. */
export const QualityReview = z.object({
  age_appropriate: z.boolean(),
  scary_level: z.number().int().min(0).max(3),
  kids_are_active_participants: z.boolean(),
  facts_consistent_with_pack: z.boolean(),
  tone_matches_request: z.boolean(),
  reasons: z.array(z.string().max(300)).default([]),
})
export type QualityReview = z.infer<typeof QualityReview>

export const QualityOutcome = z.enum(['pass', 'rewrite', 'flagged', 'discarded'])
export type QualityOutcome = z.infer<typeof QualityOutcome>

/** Stored in stories.quality. */
export const QualityResult = z.object({
  outcome: QualityOutcome,
  attempt: z.number().int().min(1).max(2),
  deterministic_passed: z.boolean(),
  failures: z.array(CheckFailure).default([]),
  /** Null when deterministic checks failed first (no model call was made). */
  review: QualityReview.nullable().default(null),
  safety: OutputSafetyReview.nullable().default(null),
  hard_violations: z.array(OutputViolation).default([]),
  /** Reasons appended to the rewrite request. */
  rewrite_reasons: z.array(z.string()).default([]),
  word_count: z.number().int().nonnegative(),
  target_words: z.object({ min: z.number().int(), max: z.number().int() }),
  /**
   * Why attempt 1 was sent back, when there was a rewrite. Without it the saved row only
   * described the attempt that was kept, and the cause of every rewrite was lost - which
   * made "reduce the rewrites" unmeasurable. Absent when attempt 1 passed.
   *
   * Both fields are OPTIONAL, not defaulted: the contract is additive, so rows saved before
   * 2026-09-29 and every consumer built against the earlier shape stay valid unchanged.
   */
  first_attempt: z
    .object({
      failures: z.array(CheckFailure),
      reasons: z.array(z.string()),
    })
    .optional(),
  /** Free local fixes applied to the model's output (lib/generate/normalize.ts). */
  normalized: z.array(z.string()).optional(),
})
export type QualityResult = z.infer<typeof QualityResult>

/** F6 AC: every selected child appears by name in >=60% of chapters. */
export const MIN_CHILD_CHAPTER_COVERAGE = 0.6
