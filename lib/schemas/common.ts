import { z } from 'zod'

/**
 * Shared primitives. IMPLEMENTATION_PLAN.md s4.5 (age bands), s3 (data model enums).
 * This file is part of the cross-lane contract: do not change without the lead's sign-off.
 */

export const AgeBand = z.enum(['A', 'B', 'C', 'D'])
export type AgeBand = z.infer<typeof AgeBand>

/** s10 F10: max 2 of these per story. */
export const Tone = z.enum([
  'funny',
  'exciting',
  'calm',
  'mysterious',
  'silly',
  'heart-warming',
])
export type Tone = z.infer<typeof Tone>

export const LengthMinutes = z.union([z.literal(5), z.literal(10), z.literal(15)])
export type LengthMinutes = z.infer<typeof LengthMinutes>

export const ReadingLevel = z.enum(['younger', 'typical', 'older'])
export type ReadingLevel = z.infer<typeof ReadingLevel>

export const StoryStatus = z.enum(['ready', 'flagged', 'failed'])
export type StoryStatus = z.infer<typeof StoryStatus>

export const FactPackStatus = z.enum(['ready', 'building', 'rejected'])
export type FactPackStatus = z.infer<typeof FactPackStatus>

export const Confidence = z.enum(['high', 'medium', 'legend'])
export type Confidence = z.infer<typeof Confidence>

/** Purposes logged to generation_logs. s3. */
export const CallPurpose = z.enum([
  'normalize',
  'factpack',
  'factpack_review',
  'write',
  'rewrite',
  'quality',
  'safety_review',
  'bible_update',
  'repair',
  'mend',
  'classify_input',
  'judge_score',
  'judge_pairwise',
])
export type CallPurpose = z.infer<typeof CallPurpose>

/** s4.5 age-band table. Ages 1-2 fall into band A. */
export function bandForAge(age: number): AgeBand {
  if (age <= 5) return 'A'
  if (age <= 8) return 'B'
  if (age <= 12) return 'C'
  return 'D'
}

/** Mixed ages: vocabulary and peril follow the YOUNGEST selected child. s4.5. */
export function bandForAges(ages: readonly number[]): AgeBand {
  if (ages.length === 0) throw new Error('bandForAges: no ages given')
  return bandForAge(Math.min(...ages))
}

/** Words per 10 minutes, per band. s4.5. */
const WORDS_PER_10_MIN: Record<AgeBand, readonly [number, number]> = {
  A: [1300, 1700],
  B: [1600, 2200],
  C: [2200, 3200],
  D: [2800, 3800],
}

/** s4.5: "5-minute and 15-minute targets scale linearly." */
export function targetWords(input: { band: AgeBand; minutes: LengthMinutes }): {
  min: number
  max: number
} {
  const range = WORDS_PER_10_MIN[input.band]
  const scale = input.minutes / 10
  return { min: Math.round(range[0] * scale), max: Math.round(range[1] * scale) }
}

/** Gate/judge tolerance around the target range. s4.4 / JUDGE_AGENT.md s3. */
export const WORD_COUNT_TOLERANCE = 0.15

export function wordCountWithinTolerance(
  wordCount: number,
  target: { min: number; max: number },
): boolean {
  return (
    wordCount >= Math.floor(target.min * (1 - WORD_COUNT_TOLERANCE)) &&
    wordCount <= Math.ceil(target.max * (1 + WORD_COUNT_TOLERANCE))
  )
}

/**
 * GUARDRAILS.md s4.3: max scary_level per band.
 *
 * Band A was 0 until 2026-09-29 (owner decision, DECISIONS #127). Level 1 is a wobble
 * answered straight away - "is it going to erupt?" "No." - and a limit of 0 rejected it, so
 * every "exciting" story for a four-year-old was rewritten and then flagged. It also
 * rejected the owner's own band-A reference: the shark story has a shadow passing over the
 * submarine and a great white at the window. Levels 2 and 3 stay out of bands A and B.
 */
export const MAX_SCARY_LEVEL: Record<AgeBand, number> = { A: 1, B: 1, C: 2, D: 2 }

export function countWords(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  return trimmed.split(/\s+/).length
}
