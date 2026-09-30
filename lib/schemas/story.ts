import { z } from 'zod'
import { AgeBand, LengthMinutes, StoryStatus, Tone, countWords } from './common'
import { RecurringElement } from './bible'

/**
 * Story output contract - IMPLEMENTATION_PLAN.md s4.4.
 * The writing model responds with JSON only, matching StoryOutput.
 */

export const Chapter = z.object({
  heading: z.string().trim().min(1).max(160),
  text: z.string().trim().min(1),
  /** Shout-along line, mainly for bands A/B. s4.1.2. */
  shout_line: z.string().trim().max(80).nullable().default(null),
})
export type Chapter = z.infer<typeof Chapter>

export const TrueFact = z.object({
  text: z.string().trim().min(1).max(400),
  /** Must map to a fact-pack fact id. F7 deterministic check `unsourced_fact`. */
  fact_id: z.string().regex(/^f\d+$/),
})
export type TrueFact = z.infer<typeof TrueFact>

export const BibleSuggestions = z.object({
  new_recurring: z.array(RecurringElement.omit({ last_used: true })).max(2).default([]),
  ending_summary: z.string().trim().max(400),
})

/** s4.1.2: 6-10 chapters. s4.4: >=8 true facts (F7), plan text says 8-14 bullets. */
export const STORY_MIN_CHAPTERS = 6
export const STORY_MAX_CHAPTERS = 10
export const STORY_MIN_TRUE_FACTS = 8
export const STORY_MAX_TRUE_FACTS = 14
/** F7 deterministic check: no chapter may exceed this share of total words. */
export const MAX_CHAPTER_WORD_SHARE = 0.4

export const StoryOutput = z.object({
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(200).nullable().default(null),
  chapters: z.array(Chapter).min(STORY_MIN_CHAPTERS).max(STORY_MAX_CHAPTERS),
  ending_line: z.string().trim().min(1).max(300),
  true_facts: z.array(TrueFact).min(STORY_MIN_TRUE_FACTS).max(STORY_MAX_TRUE_FACTS),
  bible_suggestions: BibleSuggestions,
  estimated_read_minutes: z.number().positive().max(60),
})
export type StoryOutput = z.infer<typeof StoryOutput>

/** Full prose of a story, for word counts and blocklist scans. */
export function storyText(story: StoryOutput): string {
  const parts = [story.title, story.subtitle ?? '']
  for (const ch of story.chapters) {
    parts.push(ch.heading, ch.text, ch.shout_line ?? '')
  }
  parts.push(story.ending_line)
  for (const f of story.true_facts) parts.push(f.text)
  return parts.filter(Boolean).join('\n\n')
}

/** Narrative word count: chapter bodies + ending. Excludes headings and the facts list. */
export function storyWordCount(story: StoryOutput): number {
  let total = 0
  for (const ch of story.chapters) total += countWords(ch.text)
  total += countWords(story.ending_line)
  return total
}

/** The request block handed to the writer (s6 F6). */
export const GenerationRequest = z.object({
  children: z
    .array(
      z.object({
        name: z.string(),
        age: z.number().int(),
        likes: z.array(z.string()),
        notes: z.string().nullable(),
      }),
    )
    .min(1),
  age_band: AgeBand,
  tones: z.array(Tone).min(1).max(2),
  length_minutes: LengthMinutes,
  target_words: z.object({ min: z.number().int(), max: z.number().int() }),
  topic_label: z.string(),
  topic_key: z.string(),
  /** From bible.avoid - the "do not repeat" list. */
  avoid: z.array(z.string()).default([]),
  /** GUARDRAILS.md s3.3 care_notes, when the classifier returned allow_with_care. */
  care_notes: z.string().nullable().default(null),
  /** Populated only on a rewrite: the gate/guardrail reasons from the failed attempt. */
  rewrite_reasons: z.array(z.string()).default([]),
})
export type GenerationRequest = z.infer<typeof GenerationRequest>

export const StoryRecord = z.object({
  id: z.string().uuid(),
  family_id: z.string().uuid(),
  series_id: z.string().uuid(),
  topic_input: z.string(),
  topic_key: z.string(),
  fact_pack_id: z.string().uuid().nullable(),
  tones: z.array(Tone),
  length_minutes: LengthMinutes,
  age_band: AgeBand,
  title: z.string(),
  content: StoryOutput,
  word_count: z.number().int().nonnegative(),
  status: StoryStatus,
})
export type StoryRecord = z.infer<typeof StoryRecord>
