import { describe, expect, it } from 'vitest'
import { FINISH_WAIT_MS } from '@/lib/client/finish'
import { initialStreamState, streamReducer, type StreamState } from '@/lib/client/generate'
import { RESUME_POLL_MS, resumeStory, type GenerationProgress, type ResumeDeps } from '@/lib/client/resume'
import type { SseEvent } from '@/lib/schemas'
import { streamSourceStory } from '@/lib/mock/store'
import { generationEvents } from '@/lib/mock/stream'

/**
 * Issues #59 and #82: after the story stream drops (a locked phone, a switched app), the page
 * follows the story the server is still writing, by the id it sent with the request. The
 * chapters carry on appearing where they stopped, and the story ends on the same page.
 */

const SENT = Date.parse('2026-10-31T21:21:08Z')
const GEN = 'a5f0c3d2-1b4e-4c8a-9f6d-2e7b8c9d0a1b'
const STORY = '791b81fe-4fcb-4172-af1f-6eacf91aefda'
const target = { generationId: GEN, sentAt: SENT }

type Answer = GenerationProgress | null | Error

/** A clock that only moves when the loop sleeps, and a server that answers by the clock. */
function fakeDeps(answer: (elapsedMs: number, after: number) => Answer, over: Partial<ResumeDeps> = {}) {
  let now = SENT + 180_000 // the drop came three minutes in, as on the owner's phone
  const asked: { id: string; after: number }[] = []
  const sleeps: number[] = []
  const applied: SseEvent[][] = []
  const deps: ResumeDeps = {
    progress: async (id, after) => {
      asked.push({ id, after })
      const a = answer(now - SENT, after)
      if (a instanceof Error) throw a
      return a
    },
    apply: (events) => applied.push(events),
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
    ...over,
  }
  return { deps, asked, sleeps, applied, clock: () => now }
}

const writing = (version = 0, events: unknown[] | null = null): GenerationProgress => ({
  status: 'writing',
  story_id: null,
  version,
  events,
})

const meta: SseEvent = {
  type: 'meta',
  story_id: STORY,
  series_id: '0b8f5f8e-6d2c-4f43-9a8e-1c1f6c1d2e3f',
  title: 'The Volcano Under the Garden',
  subtitle: null,
  age_band: 'B',
  target_words: { min: 1600, max: 2200 },
  topic_label: 'volcanoes',
  content_notice: null,
}
const chapter = (index: number, text: string, complete = true): SseEvent[] => [
  { type: 'chapter_start', index, heading: `Chapter ${index + 1}` },
  { type: 'chapter_delta', index, text },
  ...(complete ? [{ type: 'chapter_end', index, shout_line: null } as SseEvent] : []),
]
const errorEvent: SseEvent = {
  type: 'error',
  code: 'generation_failed',
  message: "We couldn't finish that story.",
  quota_consumed: false,
  resets_at: null,
}

describe('following the story after the connection dropped (issue #82)', () => {
  it('VT-RC4: rebuilds the reader each time the story has moved on, asking with the version it has', async () => {
    const v1 = [meta, ...chapter(0, 'One.'), ...chapter(1, 'Two, half', false)]
    const v2 = [meta, ...chapter(0, 'One.'), ...chapter(1, 'Two, whole.'), ...chapter(2, 'Three.')]
    const { deps, asked, applied } = fakeDeps((t, after) => {
      if (t < 186_000) return writing(1, after < 1 ? v1 : null)
      if (t < 196_000) return writing(2, after < 2 ? v2 : null)
      return { status: 'ready', story_id: STORY, version: 2, events: null }
    })
    expect(await resumeStory(target, deps)).toEqual({ kind: 'saved', storyId: STORY })
    expect(applied).toEqual([v1, v2])
    // It always asks for what it does not have yet, and never re-applies a snapshot it has.
    expect(asked[0]).toEqual({ id: GEN, after: 0 })
    expect(asked.at(-1)?.after).toBe(2)
  })

  it('VT-RC4: a story that ended while the phone was locked ends on the page, not in the library', async () => {
    // The mock backend's whole stream for a real fixture story: its last event is a valid `done`.
    const events = generationEvents(streamSourceStory(0), { scenario: 'ok', delayMs: 0, quota: { used: 1, limit: 3 } })
    expect((events.at(-1) as { type: string }).type).toBe('done')
    const { deps, applied } = fakeDeps(() => ({ status: 'ready', story_id: STORY, version: 9, events }))
    expect(await resumeStory(target, deps)).toEqual({ kind: 'ended' })
    expect(applied).toHaveLength(1)
  })

  it('VT-RC4: an error the stream would have sent is shown as it was sent', async () => {
    const { deps, applied } = fakeDeps(() => ({ status: 'failed', story_id: null, version: 3, events: [meta, errorEvent] }))
    expect(await resumeStory(target, deps)).toEqual({ kind: 'ended' })
    expect(applied[0]?.at(-1)).toEqual(errorEvent)
  })

  it('VT-RC4: skips an event this build does not know, as the live stream does', async () => {
    const { deps, applied } = fakeDeps(() => ({ status: 'ready', story_id: STORY, version: 1, events: [meta, { type: 'writer_note' }] }))
    expect(await resumeStory(target, deps)).toEqual({ kind: 'saved', storyId: STORY })
    expect(applied).toEqual([[meta]])
  })

  it('asks every 2 s while the tab is open', async () => {
    const { deps, sleeps } = fakeDeps((t) => (t >= 200_000 ? { status: 'ready', story_id: STORY, version: 0, events: null } : writing()))
    await resumeStory(target, deps)
    expect(sleeps.length).toBeGreaterThan(5)
    expect(sleeps.every((ms) => ms === RESUME_POLL_MS)).toBe(true)
  })
})

describe('the #59 answers stay as the fallback when there is no story so far', () => {
  it('a saved story with no snapshot opens as before', async () => {
    // Volcanoes, 2026-10-17: saved 6½ minutes after it was asked for.
    const { deps, clock } = fakeDeps((t) => (t >= 390_000 ? { status: 'ready', story_id: STORY, version: 0, events: null } : writing()))
    expect(await resumeStory(target, deps)).toEqual({ kind: 'saved', storyId: STORY })
    expect(clock() - SENT).toBeLessThan(390_000 + RESUME_POLL_MS + 1)
  })

  it('a flagged story opens too: it is saved and shown with its banner', async () => {
    const { deps } = fakeDeps(() => ({ status: 'flagged', story_id: STORY, version: 0, events: null }))
    expect(await resumeStory(target, deps)).toEqual({ kind: 'saved', storyId: STORY })
  })

  it('a story the server discarded is reported at once, not after the whole wait', async () => {
    for (const status of ['discarded', 'failed', 'refused'] as const) {
      const { deps, clock } = fakeDeps((t) => (t >= 240_000 ? { status, story_id: null, version: 0, events: null } : writing()))
      expect(await resumeStory(target, deps)).toEqual({ kind: 'not_made' })
      expect(clock() - SENT).toBeLessThan(240_000 + RESUME_POLL_MS + 1)
    }
  })

  it('no record yet (404) and errors count as "not yet", never as an answer', async () => {
    const { deps } = fakeDeps((t) =>
      t < 200_000 ? null : t < 230_000 ? new TypeError('Load failed') : { status: 'ready', story_id: STORY, version: 0, events: null },
    )
    expect(await resumeStory(target, deps)).toEqual({ kind: 'saved', storyId: STORY })
  })

  it('never answered (offline, signed out): it says it does not know, not that the story was free', async () => {
    const { deps, clock } = fakeDeps(() => new Error('401'))
    expect(await resumeStory(target, deps)).toEqual({ kind: 'unknown' })
    expect(clock()).toBeGreaterThanOrEqual(SENT + FINISH_WAIT_MS)
    expect(clock()).toBeLessThanOrEqual(SENT + FINISH_WAIT_MS + RESUME_POLL_MS)
  })

  it('stops asking when the parent leaves the page', async () => {
    const controller = new AbortController()
    const { deps } = fakeDeps(() => writing(), { signal: controller.signal, sleep: async () => controller.abort() })
    expect(await resumeStory(target, deps)).toEqual({ kind: 'cancelled' })
  })
})

describe('the replay action (issue #82)', () => {
  const fold = (events: SseEvent[], from: StreamState = initialStreamState): StreamState =>
    events.reduce<StreamState>((s, event) => streamReducer(s, { kind: 'event', event }), { ...from, phase: 'streaming' })

  it('rebuilds the same reader the live stream built, and keeps following it', () => {
    const events = [meta, ...chapter(0, 'One.'), ...chapter(1, 'Two, half', false)]
    const live = fold(events)
    const replayed = streamReducer({ ...initialStreamState, phase: 'finishing' }, { kind: 'replay', events })
    expect(replayed).toEqual({ ...live, phase: 'finishing' })
  })

  it('replaces what was on screen: a chapter the writer restarted (#74) is not kept twice', () => {
    const before = fold([meta, ...chapter(0, 'One.'), ...chapter(1, 'Cut partway', false)])
    const after = streamReducer({ ...before, phase: 'finishing' }, { kind: 'replay', events: [meta, ...chapter(0, 'One.'), ...chapter(1, 'Written again.')] })
    expect(after.chapters.map((c) => c.text)).toEqual(['One.', 'Written again.'])
  })

  it('ends as the live stream ends: an error event is the error state', () => {
    const after = streamReducer({ ...initialStreamState, phase: 'finishing' }, { kind: 'replay', events: [meta, errorEvent] })
    expect(after.phase).toBe('error')
    expect(after.error?.code).toBe('generation_failed')
  })
})
