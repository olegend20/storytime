import type { ContentNotice } from '@/lib/schemas'

/**
 * What the reader says about a story that carries a notice (issue #27). Chrome, not story:
 * it sits under the title, is hidden in Read together, and is never part of the prose.
 *
 * `borrowed_character`: the parent asked for a character from a film, game or book. The
 * story is theirs to read at home; the character is not ours or theirs to publish.
 */
export const CONTENT_NOTICE_COPY: Record<ContentNotice, string> = {
  borrowed_character:
    'This story borrows a character that belongs to someone else. It\u2019s made for reading at home with your family \u2014 please don\u2019t share or publish it.',
}
