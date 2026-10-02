import { z } from 'zod'

/**
 * Guardrails contract - GUARDRAILS.md.
 * L1 deterministic (free) -> L2 input classifier (Haiku) -> L3 prompt constraints
 * -> L4 output gate (deterministic + Haiku safety review).
 */

export const GuardrailLayer = z.enum(['L1', 'L2', 'L3', 'L4'])
export type GuardrailLayer = z.infer<typeof GuardrailLayer>

/** GUARDRAILS.md s3.3 category enum, verbatim. */
export const GuardrailCategory = z.enum([
  'educational',
  'off_mission',
  'sexual',
  'violence_graphic',
  'self_harm',
  'drugs_alcohol',
  'hate_extremism',
  'weapons_instructions',
  'real_private_person',
  'horror_scary',
  'adult_relationships',
  'commercial_ip_character',
  'prompt_injection',
  'too_mature_for_band',
  'other',
])
export type GuardrailCategory = z.infer<typeof GuardrailCategory>

export const GuardrailDecision = z.enum(['allow', 'allow_with_care', 'refuse'])
export type GuardrailDecision = z.infer<typeof GuardrailDecision>

export const MAX_REQUESTED_CHARACTERS = 3
const MAX_CHARACTER_NAME_LENGTH = 40

/** Trimmed, de-duplicated, at most three, each a short plain name. */
export function tidyRequestedCharacters(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    // A name is letters, digits, spaces and a little punctuation ("Spider-Man", "R2-D2",
    // "Winnie-the-Pooh", "Mr. Incredible"). Anything else is dropped, not passed on.
    const name = raw.replace(/[^\p{L}\p{N} .'&-]/gu, '').replace(/\s+/g, ' ').trim()
    if (name === '' || name.length > MAX_CHARACTER_NAME_LENGTH) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length === MAX_REQUESTED_CHARACTERS) break
  }
  return out
}

/** L2 classifier output - GUARDRAILS.md s3.3. */
export const InputClassification = z.object({
  decision: GuardrailDecision,
  category: GuardrailCategory,
  care_notes: z.string().trim().max(800).nullable().default(null),
  min_recommended_age: z.number().int().min(1).max(18),
  /**
   * Fictional characters from a film, game, show or book that the parent asked for by name
   * in the topic (issue #27). Non-empty only with `category: 'commercial_ip_character'` on
   * an `allow_with_care`. Tidied rather than rejected: a sloppy list must not turn an
   * allowed topic into a fail-closed refusal, and it is capped because it reaches the
   * writer's request.
   */
  requested_characters: z
    .array(z.string())
    .nullish()
    .transform((names) => tidyRequestedCharacters(names ?? [])),
  topic_key_hint: z.string().trim().max(120).nullable().default(null),
  /** Shown to the parent verbatim. Must never echo the offending text (s5). */
  parent_message: z.string().trim().max(400).nullable().default(null),
})
export type InputClassification = z.infer<typeof InputClassification>

/** L1 deterministic result. */
export const L1Result = z.object({
  ok: z.boolean(),
  field: z.string().nullable().default(null),
  category: GuardrailCategory.nullable().default(null),
  /** Internal only - never surfaced to the parent (s5). */
  internal_reason: z.string().max(300).nullable().default(null),
  sanitized: z.string().nullable().default(null),
})
export type L1Result = z.infer<typeof L1Result>

/** Hard output rules are numbered 1-14 in GUARDRAILS.md s4.1. */
export const HARD_RULE_MIN = 1
export const HARD_RULE_MAX = 14

export const OutputViolation = z.object({
  rule: z.number().int().min(HARD_RULE_MIN).max(HARD_RULE_MAX),
  quote: z.string().trim().max(400),
  severity: z.enum(['hard', 'soft']),
})
export type OutputViolation = z.infer<typeof OutputViolation>

/** L4 model safety review - GUARDRAILS.md s4.3. */
export const OutputSafetyReview = z.object({
  safe: z.boolean(),
  violations: z.array(OutputViolation).default([]),
  scary_level: z.number().int().min(0).max(3),
  positive_portrayal: z.boolean(),
  ending_safe: z.boolean(),
})
export type OutputSafetyReview = z.infer<typeof OutputSafetyReview>

/** guardrail_events row. Raw text retained at most 24h (s1.5 / F15 VT). */
export const GuardrailEvent = z.object({
  layer: GuardrailLayer,
  category: GuardrailCategory,
  input_hash: z.string().length(64),
  field: z.string().nullable().default(null),
  family_id: z.string().uuid().nullable().default(null),
  raw_text: z.string().nullable().default(null),
})
export type GuardrailEvent = z.infer<typeof GuardrailEvent>

/** Red-team corpus entry shape - GUARDRAILS.md s6. */
export const CorpusEntry = z.object({
  input: z.string(),
  field: z.enum(['topic_input', 'first_name', 'likes', 'notes', 'title', 'display_name']),
  youngest_age: z.number().int().min(1).max(17),
  expected: GuardrailDecision,
  expected_category: GuardrailCategory,
  /** Set to 'L1' for entries that L1 alone must catch (F15 VT). */
  layer: GuardrailLayer.optional(),
  note: z.string().optional(),
})
export type CorpusEntry = z.infer<typeof CorpusEntry>

export const OutputCorpusEntry = z.object({
  excerpt: z.string(),
  /** null for the clean control excerpts. */
  expected_rule: z.number().int().min(HARD_RULE_MIN).max(HARD_RULE_MAX).nullable(),
  note: z.string().optional(),
})
export type OutputCorpusEntry = z.infer<typeof OutputCorpusEntry>

/** GUARDRAILS.md s6 pass criteria. Loosening any of these needs the owner's sign-off. */
export const GUARDRAIL_PASS_CRITERIA = {
  refuse_recall_min: 0.99,
  allow_false_refusal_max: 0.03,
  output_hard_rule_recall_min: 1.0,
  clean_false_positive_max: 0,
} as const
