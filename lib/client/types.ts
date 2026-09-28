import { z } from 'zod'
import { Child, StoryRecord, targetWords } from '@/lib/schemas'

/**
 * PROVISIONAL shapes for the two endpoints the UI needs that `lib/schemas/api.ts` does not
 * yet specify: the library list and the children list.
 *
 * `lib/schemas/api.ts` is the lead's contract and covers generate / quota / suggested
 * topics. F9's library page and F10's child chips also need `GET /api/stories` and
 * `GET /api/children`, which lanes 1 and 2 own on the server. Rather than invent a parallel
 * contract, both shapes below are built by *extending* the existing schemas
 * (`StoryRecord`, `Child`) with only the fields a library card cannot be rendered without.
 *
 * ASK FOR THE LEAD: promote these into `lib/schemas/api.ts` (or tell lane 4 the real shape)
 * before the server side lands. Nothing here changes an existing schema.
 */

/** A library row: a stored story plus what a card must show without a second request. */
export const LibraryStory = StoryRecord.extend({
  /** Series display name, e.g. "Cruz & Phoenix". */
  series_title: z.string(),
  /** Position in the series, 1-based. Shown as "Story 2". */
  sequence: z.number().int().positive(),
  /** First names of the children who star in it. F11: first names only, never more. */
  child_names: z.array(z.string()),
  /** Human-readable topic, from the `meta` SSE event's `topic_label`. */
  topic_label: z.string(),
  created_at: z.string(),
})
export type LibraryStory = z.infer<typeof LibraryStory>

export const LibraryResponse = z.object({ stories: z.array(LibraryStory) })
export type LibraryResponse = z.infer<typeof LibraryResponse>

export const StoryResponse = z.object({ story: LibraryStory })
export type StoryResponse = z.infer<typeof StoryResponse>

/** F3 owns children; the UI only reads them. */
export const ChildrenResponse = z.object({ children: z.array(Child) })
export type ChildrenResponse = z.infer<typeof ChildrenResponse>

/** Reading-time estimate shown on a library card, from the stored word count. */
export const WORDS_PER_MINUTE_READ_ALOUD = 140

export function readMinutes(story: Pick<LibraryStory, 'word_count'>): number {
  return Math.max(1, Math.round(story.word_count / WORDS_PER_MINUTE_READ_ALOUD))
}

/** Re-exported so callers do not reach past `lib/client` for the band word targets. */
export { targetWords }
