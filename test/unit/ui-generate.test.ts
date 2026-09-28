import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FREE_RETRY_NOTE,
  initialStreamState,
  needsFreeRetryNote,
  readGenerationEvents,
  startGeneration,
  streamProgress,
  streamReducer,
  type StreamAction,
} from '@/lib/client/generate'
import { sseFrame } from '@/lib/client/sse'
import { HTTP_STATUS_FOR_ERROR, type GenerateStoryBody, type SseEvent } from '@/lib/schemas'
import fixtures from '@/lib/mock/fixture-stories.json'

const story = fixtures.stories[0]
if (!story) throw new Error('fixture stories missing - run pnpm fixtures:ui')

const META: SseEvent = {
  type: 'meta',
  story_id: '00000000-0000-4000-8000-000000000001',
  series_id: '00000000-0000-4000-8000-000000000002',
  title: 'Cruz, Phoenix and the Brick That Clicked',
  subtitle: 'A bedtime adventure',
  age_band: 'A',
  target_words: { min: 1300, max: 1700 },
  topic_label: 'the history of LEGO',
}

function apply(actions: readonly StreamAction[]) {
  return actions.reduce(streamReducer, initialStreamState)
}

describe('streamReducer', () => {
  it('follows the contract order: meta, chapter_start, chapter_delta, chapter_end', () => {
    const state = apply([
      { kind: 'start' },
      { kind: 'event', event: META },
      { kind: 'event', event: { type: 'chapter_start', index: 0, heading: 'Chapter 1' } },
      { kind: 'event', event: { type: 'chapter_delta', index: 0, text: 'It was ' } },
      { kind: 'event', event: { type: 'chapter_delta', index: 0, text: 'a rainy Saturday.' } },
      { kind: 'event', event: { type: 'chapter_end', index: 0, shout_line: 'WHOOOOSH!' } },
    ])
    expect(state.phase).toBe('streaming')
    expect(state.meta?.title).toBe(META.title)
    expect(state.chapters).toEqual([
      {
        heading: 'Chapter 1',
        text: 'It was a rainy Saturday.',
        shout_line: 'WHOOOOSH!',
        complete: true,
      },
    ])
  })

  it('accepts a delta for a chapter whose start has not arrived yet', () => {
    // Defensive: nothing in the contract promises strict interleaving across chapters.
    const state = apply([
      { kind: 'start' },
      { kind: 'event', event: { type: 'chapter_delta', index: 2, text: 'later' } },
    ])
    expect(state.chapters).toHaveLength(3)
    expect(state.chapters[2]?.text).toBe('later')
    expect(state.chapters[0]?.text).toBe('')
  })

  it('counts unknown events instead of failing (the contract requires tolerating them)', () => {
    const state = apply([{ kind: 'start' }, { kind: 'unknown' }, { kind: 'unknown' }])
    expect(state.unknownEvents).toBe(2)
    expect(state.phase).toBe('connecting')
    expect(state.error).toBeNull()
  })

  it('takes the final story from done', () => {
    const state = apply([
      { kind: 'start' },
      { kind: 'event', event: META },
      {
        kind: 'event',
        event: {
          type: 'done',
          story_id: META.story_id,
          story: story.content,
          quality: {
            outcome: 'pass',
            attempt: 1,
            deterministic_passed: true,
            failures: [],
            review: null,
            safety: null,
            hard_violations: [],
            rewrite_reasons: [],
            word_count: story.word_count,
            target_words: story.target_words,
          },
          word_count: story.word_count,
          quota: { used: 2, limit: 3 },
        } as SseEvent,
      },
    ])
    expect(state.phase).toBe('done')
    expect(state.story?.chapters).toHaveLength(story.content.chapters.length)
    expect(state.story?.true_facts).toHaveLength(story.content.true_facts.length)
    expect(state.quota).toEqual({ used: 2, limit: 3 })
    expect(state.chapters.every((c) => c.complete)).toBe(true)
  })

  it('keeps the streamed chapters when done.story fails validation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = apply([
      { kind: 'start' },
      { kind: 'event', event: META },
      { kind: 'event', event: { type: 'chapter_start', index: 0, heading: 'Chapter 1' } },
      { kind: 'event', event: { type: 'chapter_delta', index: 0, text: 'Prose.' } },
      {
        kind: 'event',
        // A story with one chapter is not a valid StoryOutput (min 6). The reader must still
        // show what it already received rather than blanking.
        event: { type: 'done', story_id: META.story_id, story: { title: 'x' }, quality: null, word_count: 3, quota: { used: 1, limit: 3 } } as unknown as SseEvent,
      },
    ])
    expect(state.phase).toBe('done')
    expect(state.story).toBeNull()
    expect(state.chapters[0]?.text).toBe('Prose.')
    warn.mockRestore()
  })

  it('records an error event with its quota_consumed flag', () => {
    const state = apply([
      { kind: 'start' },
      {
        kind: 'event',
        event: {
          type: 'error',
          code: 'generation_failed',
          message: "We couldn't make a story we're happy with tonight.",
          quota_consumed: false,
          resets_at: null,
        },
      },
    ])
    expect(state.phase).toBe('error')
    expect(state.error?.quota_consumed).toBe(false)
  })

  it('reset returns to the form state', () => {
    const state = apply([
      { kind: 'start' },
      { kind: 'event', event: META },
      { kind: 'reset' },
    ])
    expect(state).toEqual(initialStreamState)
  })
})

describe('streamProgress', () => {
  it('is null before meta arrives', () => {
    expect(streamProgress(initialStreamState)).toBeNull()
  })

  it('tracks words against the target midpoint and never reaches 1 while streaming', () => {
    const words = Array.from({ length: 1500 }, () => 'word').join(' ')
    const state = apply([
      { kind: 'start' },
      { kind: 'event', event: META },
      { kind: 'event', event: { type: 'chapter_delta', index: 0, text: words } },
    ])
    const progress = streamProgress(state)
    expect(progress).toBeGreaterThan(0.9)
    expect(progress).toBeLessThan(1)
  })
})

describe('needsFreeRetryNote', () => {
  it('is false when the story did cost quota', () => {
    expect(
      needsFreeRetryNote({ code: 'x', message: 'anything', quota_consumed: true, resets_at: null }),
    ).toBe(false)
  })

  it('is true when nothing was consumed and the message does not already say so', () => {
    expect(
      needsFreeRetryNote({
        code: 'topic_refused',
        message: "We can't make a story about that.",
        quota_consumed: false,
        resets_at: null,
      }),
    ).toBe(true)
  })

  it('is false when the server message already says it, so the parent is not told twice', () => {
    for (const message of [
      "We couldn't make a story tonight. This didn't use one of your stories — try again.",
      'This didn’t use one of your stories.',
    ]) {
      expect(needsFreeRetryNote({ code: 'x', message, quota_consumed: false, resets_at: null })).toBe(
        false,
      )
    }
  })

  it('the note contains the exact wording F10 requires', () => {
    expect(FREE_RETRY_NOTE.toLowerCase()).toContain("try again")
    expect(FREE_RETRY_NOTE.toLowerCase()).toContain("this didn't use one of your stories")
  })
})

const BODY: GenerateStoryBody = {
  child_ids: ['00000000-0000-4000-8000-00000000000a'],
  topic_input: 'the history of LEGO',
  tones: ['funny'],
  length_minutes: 10,
}

describe('startGeneration', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the parsed body for a pre-stream failure with its real status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: 'quota_exceeded',
            message: "That's all three for today.",
            quota_consumed: false,
            resets_at: '2026-09-28T00:00:00.000Z',
          }),
          { status: HTTP_STATUS_FOR_ERROR.quota_exceeded },
        ),
      ),
    )
    const result = await startGeneration(BODY)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('quota_exceeded')
    expect(result.error?.quota_consumed).toBe(false)
    expect(result.error?.resets_at).toBe('2026-09-28T00:00:00.000Z')
  })

  it('never claims quota was consumed when the error body is unreadable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })))
    const result = await startGeneration(BODY)
    expect(result.ok).toBe(false)
    expect(result.error?.quota_consumed).toBe(false)
  })

  it('reports a network failure as something the parent can retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const result = await startGeneration(BODY)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('network_error')
    expect(result.error?.quota_consumed).toBe(false)
  })
})

describe('readGenerationEvents', () => {
  it('yields known events and marks unknown ones without throwing', async () => {
    const body =
      sseFrame(META) +
      // A type lane 2 might add later.
      sseFrame({ type: 'writer_note', note: 'hello' }) +
      // Malformed JSON.
      'data: {not json\n\n' +
      sseFrame({ type: 'chapter_start', index: 0, heading: 'Chapter 1' })
    const stream = new Response(body).body
    if (!stream) throw new Error('no stream')
    const kinds: string[] = []
    for await (const action of readGenerationEvents(stream)) {
      kinds.push(action.kind === 'event' ? action.event.type : action.kind)
    }
    expect(kinds).toEqual(['meta', 'unknown', 'unknown', 'chapter_start'])
  })
})
