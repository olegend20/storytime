import { z } from 'zod'
import { LengthMinutes, Tone } from './common'
import { Child } from './child'
import { StoryOutput, StoryRecord } from './story'
import { QualityResult } from './quality'

/**
 * HTTP + SSE contract between the AI core (lane 2, F6) and the frontend (lane 4, F9/F10).
 *
 * IMPLEMENTATION_PLAN.md §7 makes the lead the owner of this interface so lanes 2 and 4
 * can build in parallel. Lane 4 builds against it with fixtures from day 1; lane 2
 * implements it. Neither changes it without the lead.
 */

// ---------------------------------------------------------------- POST /api/stories/generate
export const GenerateStoryBody = z.object({
  child_ids: z.array(z.string().uuid()).min(1).max(8),
  topic_input: z.string().trim().min(2).max(200),
  tones: z.array(Tone).min(1).max(2),
  length_minutes: LengthMinutes,
})
export type GenerateStoryBody = z.infer<typeof GenerateStoryBody>

/**
 * SSE event stream. Every event is one `data:` line of JSON with a `type`.
 * The client must tolerate unknown `type` values so lane 2 can add events without
 * breaking a deployed frontend.
 */
export const SseEvent = z.discriminatedUnion('type', [
  /**
   * Sent as soon as the fact pack is ready, BEFORE the writer starts - so the children have
   * something to do during the two minutes the writer thinks before the first chapter. Only
   * facts the story may use: kid-safe and within the youngest child's age, in the pack's
   * own order, at most FACT_CARDS_MAX. Added 2026-09-29; older clients ignore it.
   */
  z.object({
    type: z.literal('facts'),
    topic_label: z.string(),
    facts: z.array(z.object({ id: z.string(), text: z.string() })),
  }),
  /** Lets the reader render a header before any prose (F6 AC: title ≤5s). */
  z.object({
    type: z.literal('meta'),
    story_id: z.string().uuid(),
    series_id: z.string().uuid(),
    title: z.string(),
    subtitle: z.string().nullable(),
    age_band: z.string(),
    target_words: z.object({ min: z.number(), max: z.number() }),
    topic_label: z.string(),
  }),
  /** A chapter opens. Emitted before its deltas. */
  z.object({
    type: z.literal('chapter_start'),
    index: z.number().int().nonnegative(),
    heading: z.string(),
  }),
  /** Prose for the chapter at `index`. Concatenate in arrival order. */
  z.object({
    type: z.literal('chapter_delta'),
    index: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('chapter_end'),
    index: z.number().int().nonnegative(),
    shout_line: z.string().nullable(),
  }),
  /** Terminal on success. `quality.outcome === 'flagged'` means render the soft banner. */
  z.object({
    type: z.literal('done'),
    story_id: z.string().uuid(),
    story: StoryOutput,
    quality: QualityResult,
    word_count: z.number().int(),
    /** Quota AFTER this story. */
    quota: z.object({ used: z.number().int(), limit: z.number().int() }),
  }),
  /**
   * Terminal on failure. `quota_consumed: false` lets the UI say
   * "this didn't use one of your stories" truthfully (F10).
   */
  z.object({
    type: z.literal('error'),
    code: z.enum([
      'quota_exceeded',
      'topic_refused',
      'too_mature_for_band',
      'generation_failed',
      'service_paused',
      'budget_exceeded',
      'invalid_request',
    ]),
    /** Parent-facing copy from config/guardrails/messages.json. Safe to render verbatim. */
    message: z.string(),
    quota_consumed: z.boolean(),
    /** Present for quota_exceeded: local reset time, ISO 8601. */
    resets_at: z.string().nullable().default(null),
  }),
])
export type SseEvent = z.infer<typeof SseEvent>

/** How many facts the `facts` event carries: enough for the wait, never the whole pack. */
export const FACT_CARDS_MAX = 12

/** The facts a story may use, as cards for the waiting children. */
export function factCardsFor(
  pack: { topic_label: string; facts: { id: string; text: string; kid_safe: boolean; min_age: number }[] } | null,
  youngestAge: number,
): Extract<SseEvent, { type: 'facts' }> | null {
  if (!pack) return null
  const facts = pack.facts
    .filter((f) => f.kid_safe && f.min_age <= youngestAge)
    .slice(0, FACT_CARDS_MAX)
    .map((f) => ({ id: f.id, text: f.text }))
  if (facts.length === 0) return null
  return { type: 'facts', topic_label: pack.topic_label, facts }
}

/**
 * Non-streaming failures that happen BEFORE the stream opens return a normal JSON body
 * with the matching HTTP status, not an SSE event:
 *   429 quota_exceeded · 422 topic_refused / too_mature_for_band
 *   503 service_paused / budget_exceeded · 400 invalid_request
 * Once the stream is open, failures arrive as an `error` event with HTTP 200.
 */
export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  quota_consumed: z.boolean(),
  resets_at: z.string().nullable().default(null),
  /**
   * Which input field the error is about, for a form to highlight. Lane 1's CRUD endpoints
   * answer in this shape too, so one client-side renderer handles validation errors and
   * generation errors alike.
   *
   * `.optional()` rather than `.nullable().default(null)` on purpose: a default makes the
   * property REQUIRED on zod's inferred output type, which would break every existing
   * construction site for a field that is absent most of the time.
   */
  field: z.string().optional(),
})
export type ErrorBody = z.infer<typeof ErrorBody>

export const HTTP_STATUS_FOR_ERROR: Record<string, number> = {
  invalid_request: 400,
  topic_refused: 422,
  too_mature_for_band: 422,
  quota_exceeded: 429,
  generation_failed: 502,
  service_paused: 503,
  budget_exceeded: 503,
}

// ---------------------------------------------------------------- GET /api/quota
export const QuotaResponse = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** The owner's own family (DECISIONS #141): no daily limit. Absent for everyone else. */
  unlimited: z.boolean().optional(),
  /** Local midnight in the family's timezone, ISO 8601. */
  resets_at: z.string(),
  /** False when GENERATION_ENABLED=false or the daily budget is spent. */
  generation_enabled: z.boolean(),
})
export type QuotaResponse = z.infer<typeof QuotaResponse>

// ---------------------------------------------------------------- GET /api/topics/suggested
export const SuggestedTopic = z.object({
  label: z.string(),
  topic_key: z.string(),
  /** True when a fact pack already exists, so generation will be an instant cache hit. */
  warm: z.boolean(),
})
export const SuggestedTopicsResponse = z.object({ topics: z.array(SuggestedTopic).max(8) })
export type SuggestedTopicsResponse = z.infer<typeof SuggestedTopicsResponse>

/** F8: 3 new stories per family per calendar day, in the family's own timezone. */
export const DAILY_STORY_LIMIT = 3

// ---------------------------------------------------------------- GET /api/stories
/**
 * A library row: a stored story plus what a card must show without a second request.
 * Promoted from lane 4's provisional `lib/client/types.ts` so the server side (lanes 1 and 2)
 * and the UI build against one shape. Extends `StoryRecord` rather than restating it.
 */
export const LibraryStory = StoryRecord.extend({
  /** Series display name, e.g. "Milo & Juno". */
  series_title: z.string(),
  /** Position in the series, 1-based. Shown as "Story 2". */
  sequence: z.number().int().positive(),
  /** First names of the children who star in it. F11: first names only, never more. */
  child_names: z.array(z.string()),
  /** Human-readable topic, matching the `meta` SSE event's `topic_label`. */
  topic_label: z.string(),
  created_at: z.string(),
})
export type LibraryStory = z.infer<typeof LibraryStory>

export const LibraryResponse = z.object({ stories: z.array(LibraryStory) })
export type LibraryResponse = z.infer<typeof LibraryResponse>

export const StoryResponse = z.object({ story: LibraryStory })
export type StoryResponse = z.infer<typeof StoryResponse>

// ---------------------------------------------------------------- GET /api/children
/** F3 owns children; the UI only reads them. */
export const ChildrenResponse = z.object({ children: z.array(Child) })
export type ChildrenResponse = z.infer<typeof ChildrenResponse>
