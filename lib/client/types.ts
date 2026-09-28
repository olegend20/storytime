import { targetWords, type LibraryStory } from '@/lib/schemas'

/**
 * UI-side helpers. The response SHAPES now live in `lib/schemas/api.ts` - lane 4 proposed
 * them here provisionally and the lead promoted them into the contract, so the server side
 * (lanes 1 and 2) and the UI build against one definition. Re-exported below so callers do
 * not reach past `lib/client`.
 */

export {
  LibraryStory,
  LibraryResponse,
  StoryResponse,
  ChildrenResponse,
} from '@/lib/schemas'
export type {
  LibraryStory as LibraryStoryType,
  LibraryResponse as LibraryResponseType,
  StoryResponse as StoryResponseType,
  ChildrenResponse as ChildrenResponseType,
} from '@/lib/schemas'

/** Reading-time estimate shown on a library card, from the stored word count. */
export const WORDS_PER_MINUTE_READ_ALOUD = 140

export function readMinutes(story: Pick<LibraryStory, 'word_count'>): number {
  return Math.max(1, Math.round(story.word_count / WORDS_PER_MINUTE_READ_ALOUD))
}

/** Re-exported so callers do not reach past `lib/client` for the band word targets. */
export { targetWords }
