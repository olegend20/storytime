import type { Tone, TrueFact } from '@/lib/schemas'
import type { StreamState, StreamingChapter } from './generate'
import { readMinutes, type LibraryStory } from './types'

/**
 * One view model for the reader, so the streaming view and the saved-story view are literally
 * the same component.
 *
 * That is not a tidiness point. F9 requires that re-reading a saved story costs nothing and F10
 * requires a streaming reader; if those were two components they would drift, and the one a
 * parent sees most (the saved one) would be the one that got less attention.
 */
export interface ReaderStory {
  /** Null only for a stream that has not sent `meta` yet. */
  id: string | null
  title: string
  subtitle: string | null
  chapters: StreamingChapter[]
  endingLine: string | null
  trueFacts: readonly TrueFact[]
  childNames: readonly string[]
  topicLabel: string
  tones: readonly Tone[]
  /** Read-aloud estimate in minutes; null while the story is still arriving. */
  readMinutes: number | null
  createdAt: string | null
}

export function readerFromLibraryStory(story: LibraryStory): ReaderStory {
  return {
    id: story.id,
    title: story.content.title,
    subtitle: story.content.subtitle,
    chapters: story.content.chapters.map((c) => ({ ...c, complete: true })),
    endingLine: story.content.ending_line,
    trueFacts: story.content.true_facts,
    childNames: story.child_names,
    topicLabel: story.topic_label,
    tones: story.tones,
    readMinutes: readMinutes(story),
    createdAt: story.created_at,
  }
}

export function readerFromStream(
  state: StreamState,
  context: { childNames: readonly string[]; tones: readonly Tone[] },
): ReaderStory {
  return {
    id: state.meta?.story_id ?? null,
    title: state.meta?.title ?? '',
    subtitle: state.meta?.subtitle ?? null,
    chapters: state.chapters,
    endingLine: state.story?.ending_line ?? null,
    trueFacts: state.story?.true_facts ?? [],
    childNames: context.childNames,
    topicLabel: state.meta?.topic_label ?? '',
    tones: context.tones,
    readMinutes:
      state.wordCount !== null && state.wordCount > 0 ? Math.max(1, Math.round(state.wordCount / 140)) : null,
    createdAt: null,
  }
}

/** "Milo & Juno" - first names only (F11). */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

/** Sentence-case tone list for the reader's meta line. */
export function describeTones(tones: readonly Tone[]): string {
  return tones.join(' and ')
}
