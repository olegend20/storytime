import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StoryReader } from '@/components/reader/StoryReader'
import type { ReaderStory } from '@/lib/client/reader'
import { SECOND_LOOK_COPY } from '@/lib/client/second-look'

/**
 * The "second look" banner on a flagged story must not promise a free story.
 *
 * A flagged story is saved and delivered, so `runGeneration()` consumes a day's story for it,
 * exactly as for a ready one (test/int/pipeline.test.ts: VT-D3 and the F7 flag test assert
 * `consumeQuota`). The banner used to say "make another - it won't use one of your stories",
 * which the product never kept.
 */

const story: ReaderStory = {
  id: 'story-1',
  title: 'The Night the Volcano Woke',
  subtitle: null,
  chapters: [{ heading: 'Chapter 1', text: 'Mia looked up at the mountain.', shout_line: null, complete: true }],
  endingLine: 'The end.',
  trueFacts: [],
  childNames: ['Mia'],
  topicLabel: 'volcanoes',
  tones: [],
  readMinutes: 1,
  createdAt: null,
  contentNotice: null,
}

function render(flagged: boolean): string {
  return renderToStaticMarkup(createElement(StoryReader, { story, flagged }))
}

describe('second-look banner', () => {
  it('makes no promise that another story is free', () => {
    const free = /won.?t (use|count)|doesn.?t (use|count)|not (use|count)|free|on us|no charge|without using/i
    expect(SECOND_LOOK_COPY).not.toMatch(free)
  })

  it('says plainly that another story uses one of the day’s stories', () => {
    expect(SECOND_LOOK_COPY).toMatch(/will use one of today’s stories/)
  })

  it('shows the copy on a flagged story, and nothing on a ready one', () => {
    const escaped = SECOND_LOOK_COPY.replace(/’/g, '&#x27;').replace(/'/g, '&#x27;')
    const flaggedHtml = render(true)
    expect(flaggedHtml).toContain('data-testid="second-look"')
    expect(flaggedHtml.includes(SECOND_LOOK_COPY) || flaggedHtml.includes(escaped)).toBe(true)
    expect(render(false)).not.toContain('data-testid="second-look"')
  })
})
