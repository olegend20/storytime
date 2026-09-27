import { z } from 'zod'

/**
 * Story Bible - IMPLEMENTATION_PLAN.md s4.2.
 *
 * This is the ONLY series memory. Kickoff rule 8: a previous story's full text must
 * never enter a generation prompt. The bible is capped at 800 tokens precisely so that
 * series memory cannot grow with the number of nights.
 */

export const BIBLE_TOKEN_LIMIT = 800
export const BIBLE_MAX_TOPICS_COVERED = 20
export const BIBLE_MAX_RECURRING = 8

export const RecurringType = z.enum(['device', 'character', 'place', 'object'])
export type RecurringType = z.infer<typeof RecurringType>

export const RecurringElement = z.object({
  name: z.string().trim().min(1).max(80),
  type: RecurringType,
  rule: z.string().trim().min(1).max(240),
  /** For LRU trimming to BIBLE_MAX_RECURRING. Set by the bible service, not the model. */
  last_used: z.string().date().optional(),
})
export type RecurringElement = z.infer<typeof RecurringElement>

export const BibleChild = z.object({
  name: z.string().trim().min(1).max(30),
  age: z.number().int().min(1).max(17),
  likes: z.array(z.string().max(40)).max(10),
  role_notes: z.string().max(160).nullable().default(null),
})
export type BibleChild = z.infer<typeof BibleChild>

export const TopicCovered = z.object({
  topic: z.string().trim().min(1).max(120),
  story_id: z.string().uuid().nullable().default(null),
  date: z.string().date(),
})
export type TopicCovered = z.infer<typeof TopicCovered>

export const LastStory = z.object({
  title: z.string().trim().max(160),
  ending: z.string().trim().max(400),
})

export const StoryBible = z.object({
  children: z.array(BibleChild).min(1),
  recurring: z.array(RecurringElement).max(BIBLE_MAX_RECURRING).default([]),
  catchphrases: z.array(z.string().max(60)).max(10).default([]),
  topics_covered: z.array(TopicCovered).max(BIBLE_MAX_TOPICS_COVERED).default([]),
  last_story: LastStory.nullable().default(null),
  tone_history: z.array(z.string().max(40)).max(20).default([]),
  /** "do not repeat" hints fed into the request block. */
  avoid: z.array(z.string().max(160)).max(10).default([]),
})
export type StoryBible = z.infer<typeof StoryBible>

/** Row shape in story_bibles. Optimistic concurrency via `version` (F4 AC). */
export const StoryBibleRecord = z.object({
  id: z.string().uuid(),
  series_id: z.string().uuid(),
  family_id: z.string().uuid(),
  version: z.number().int().positive(),
  content: StoryBible,
  token_estimate: z.number().int().nonnegative(),
})
export type StoryBibleRecord = z.infer<typeof StoryBibleRecord>
