import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialStreamState, streamReducer, type StreamState } from '@/lib/client/generate'
import { PROGRESS_WRITE_MS, ProgressRecorder, compactEvents, readGenerationProgress } from '@/lib/generate/progress'
import { progressLine } from '@/lib/eval/harness'
import { SseChannel } from '@/lib/generate/sse'
import { streamSourceStory } from '@/lib/mock/store'
import { generationEvents } from '@/lib/mock/stream'
import type { SseEvent } from '@/lib/schemas'

/**
 * Issue #82: the story so far, kept for a page that lost its stream. VT-RC1: the compact
 * snapshot rebuilds the reader the live stream built. VT-RC2: it is written throttled, in
 * order, and never at the stream's expense.
 */

const fold = (events: SseEvent[]): StreamState =>
  events.reduce<StreamState>((s, event) => streamReducer(s, { kind: 'event', event }), { ...initialStreamState, phase: 'streaming' })

/** The mock backend's stream for a fixture story, in a given scenario. */
const streamOf = (scenario: 'ok' | 'writer_resumed' | 'midstream_failure') =>
  generationEvents(streamSourceStory(0), { scenario, delayMs: 0, quota: { used: 1, limit: 3 } }) as SseEvent[]

function recordingDb(opts: { fail?: boolean; delayMs?: number } = {}) {
  const rows: { version: number; events: SseEvent[] }[] = []
  const db = {
    from: () => ({
      upsert: async (row: { version: number; events: SseEvent[] }) => {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        if (opts.fail) return { error: { message: 'database down' } }
        rows.push(structuredClone(row))
        return { error: null }
      },
    }),
  }
  return { db: db as never, rows }
}

describe('VT-RC1: the snapshot rebuilds the reader the live stream built', () => {
  for (const scenario of ['ok', 'writer_resumed', 'midstream_failure'] as const) {
    it(`${scenario}: at every point in the stream`, () => {
      const events = streamOf(scenario)
      let terminal: SseEvent | null = null
      for (let n = 1; n <= events.length; n += 1) {
        const prefix = events.slice(0, n)
        const last = prefix.at(-1)!
        if (last.type === 'done' || last.type === 'error') terminal = last
        const live = fold(prefix)
        expect(fold(compactEvents(live, terminal))).toEqual(live)
      }
    })
  }

  it('is a few events, not thousands: one delta per chapter while it is written', () => {
    const events = streamOf('ok')
    const writing = events.slice(0, events.findIndex((e) => e.type === 'done'))
    const live = fold(writing)
    const compact = compactEvents(live, null)
    expect(compact.filter((e) => e.type === 'chapter_delta')).toHaveLength(live.chapters.length)
    expect(compact.length).toBeLessThan(writing.length / 3)
  })

  it('once done, the story is sent once: facts, meta and `done`, not every chapter again', () => {
    const events = streamOf('ok')
    const compact = compactEvents(fold(events), events.at(-1)!)
    expect(compact.map((e) => e.type)).toEqual(['facts', 'meta', 'done'])
  })
})

describe('VT-RC2: written throttled, in order, and never at the stream\'s expense', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('at most once per 1.5 s while prose streams, and at once on a chapter end', async () => {
    const { db, rows } = recordingDb()
    const recorder = new ProgressRecorder(db, 'gen', 'fam')
    recorder.observe({ type: 'chapter_start', index: 0, heading: 'One' })
    for (let i = 0; i < 200; i += 1) {
      recorder.observe({ type: 'chapter_delta', index: 0, text: 'word ' })
      await vi.advanceTimersByTimeAsync(20) // 4 s of prose
    }
    // 4 s of deltas: the first write as soon as allowed, then one per 1.5 s.
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.length).toBeLessThanOrEqual(Math.ceil(4_000 / PROGRESS_WRITE_MS) + 1)
    const before = rows.length
    recorder.observe({ type: 'chapter_end', index: 0, shout_line: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(rows.length).toBe(before + 1)
    expect(rows.at(-1)!.events.at(-1)).toMatchObject({ type: 'chapter_end' })
    await recorder.settled()
    expect(recorder.stats).toMatchObject({ failures: 0 })
  })

  it('versions only go up, even when writes are slow and the stream is not', async () => {
    const { db, rows } = recordingDb({ delayMs: 400 })
    const recorder = new ProgressRecorder(db, 'gen', 'fam')
    for (const event of streamOf('ok')) {
      recorder.observe(event)
      await vi.advanceTimersByTimeAsync(5)
    }
    const settled = recorder.settled()
    await vi.runAllTimersAsync()
    await settled
    const versions = rows.map((r) => r.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
    expect(rows.at(-1)!.events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('a database that fails never throws, never delays a push, and the page gets every event', async () => {
    const { db } = recordingDb({ fail: true, delayMs: 10_000 })
    const recorder = new ProgressRecorder(db, 'gen', 'fam')
    const channel = new SseChannel()
    channel.onPush((e) => recorder.observe(e))
    const events = streamOf('ok')
    for (const event of events) channel.push(event)
    channel.close()
    const received: SseEvent[] = []
    for await (const e of channel.events()) received.push(e)
    expect(received).toEqual(events)
    const settled = recorder.settled()
    await vi.runAllTimersAsync()
    await settled
    expect(recorder.stats.writes).toBe(0)
    expect(recorder.stats.failures).toBeGreaterThan(0)
  })

  it('a slow database never queues more than the newest snapshot behind the write in flight', async () => {
    const { db, rows } = recordingDb({ delayMs: 3_000 })
    const recorder = new ProgressRecorder(db, 'gen', 'fam')
    const events = streamOf('ok')
    for (const event of events) {
      recorder.observe(event)
      await vi.advanceTimersByTimeAsync(5)
    }
    const settled = recorder.settled()
    await vi.runAllTimersAsync()
    await settled
    // Every chapter end is urgent, yet with 3 s writes only a couple of writes happen at all.
    expect(rows.length).toBeLessThanOrEqual(Math.ceil((events.length * 5) / 3_000) + 2)
    expect(rows.at(-1)!.events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('a missing table (a deploy before its migration) is tried once, then left alone', async () => {
    let tries = 0
    const db = { from: () => ({ upsert: async () => (tries++, { error: { code: '42P01', message: 'relation "generation_progress" does not exist' } }) }) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recorder = new ProgressRecorder(db as never, 'gen', 'fam')
    for (const event of streamOf('ok')) {
      recorder.observe(event)
      await vi.advanceTimersByTimeAsync(5)
    }
    const settled = recorder.settled()
    await vi.runAllTimersAsync()
    await settled
    expect(tries).toBe(1)
    warn.mockRestore()
  })

  it('a listener that throws is ignored by the channel', async () => {
    const channel = new SseChannel()
    channel.onPush(() => {
      throw new Error('boom')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = streamOf('ok')[0]!
    channel.push(event)
    channel.close()
    const received: SseEvent[] = []
    for await (const e of channel.events()) received.push(e)
    expect(received).toEqual([event])
    warn.mockRestore()
  })

  it('a listener still hears every event after the page has gone (the stream was cancelled)', async () => {
    const heard: SseEvent[] = []
    const channel = new SseChannel()
    channel.onPush((e) => heard.push(e))
    const events = streamOf('ok')
    const reader = channel.toReadableStream().getReader()
    channel.push(events[0]!)
    await reader.read()
    await reader.cancel() // the phone locked
    for (const event of events.slice(1)) channel.push(event)
    expect(heard).toEqual(events)
  })
})

describe('the progress read falls back to #59 when the snapshot cannot be read', () => {
  it('a missing table still answers how the request ended', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const row = { status: 'ready', story_id: '791b81fe-4fcb-4172-af1f-6eacf91aefda', started_at: new Date().toISOString() }
    const db = {
      from: (table: string) => {
        const q = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () =>
            table === 'generation_requests'
              ? { data: row, error: null }
              : { data: null, error: { message: 'relation "generation_progress" does not exist' } },
        }
        return q
      },
    }
    const view = await readGenerationProgress(db as never, 'fam', 'a5f0c3d2-1b4e-4c8a-9f6d-2e7b8c9d0a1b', 0)
    expect(view).toEqual({ status: 'ready', story_id: row.story_id, version: 0, events: null })
    warn.mockRestore()
  })
})

describe('the eval reports whether the story so far kept up (issue #82)', () => {
  it('snapshots per story, lag p50/p95 and failures; nothing for a run without it', () => {
    const line = progressLine([
      { progress: { writes: 100, failures: 0, lag_ms: [10, 20, 30] } },
      { progress: { writes: 120, failures: 1, lag_ms: [40, 900] } },
      {},
    ])
    expect(line).toMatch(/^  progress \(issue #82\): 2 stories, 220 snapshots \(median 110 per story\), lag p50 \d+ ms, p95 \d+ ms, 1 write failure\(s\)$/)
    expect(progressLine([{}])).toBeNull()
  })
})
