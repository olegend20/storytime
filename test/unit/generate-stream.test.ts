import { describe, expect, it } from 'vitest'
import { IncrementalJsonScanner } from '@/lib/generate/json-stream'
import { StoryStreamParser } from '@/lib/generate/story-stream'
import { parseStoryOutputLocal } from '@/lib/generate/parse'
import { SseChannel, encodeSse } from '@/lib/generate/sse'
import { SseEvent } from '@/lib/schemas'
import { goodStory } from '../helpers/story'

/**
 * F6: progressive rendering. The client must see the title before any prose and chapters as
 * they arrive, which means scanning one streaming JSON object rather than waiting for it.
 *
 * These tests feed the same payload in several chunkings - one byte at a time included -
 * because the whole risk in an incremental scanner is a boundary landing mid-escape or
 * mid-key.
 */

type Emitted =
  | { t: 'meta'; title: string; subtitle: string | null }
  | { t: 'start'; index: number; heading: string }
  | { t: 'delta'; index: number; text: string }
  | { t: 'end'; index: number; shout: string | null }

function runParser(json: string, chunkSize: number): Emitted[] {
  const events: Emitted[] = []
  const parser = new StoryStreamParser({
    onMeta: ({ title, subtitle }) => events.push({ t: 'meta', title, subtitle }),
    onChapterStart: (index, heading) => events.push({ t: 'start', index, heading }),
    onChapterDelta: (index, text) => events.push({ t: 'delta', index, text }),
    onChapterEnd: (index, shout) => events.push({ t: 'end', index, shout }),
  })
  for (let i = 0; i < json.length; i += chunkSize) {
    parser.feed(json.slice(i, i + chunkSize))
  }
  parser.end()
  return events
}

function chapterText(events: Emitted[], index: number): string {
  return events
    .filter((e): e is Extract<Emitted, { t: 'delta' }> => e.t === 'delta' && e.index === index)
    .map((e) => e.text)
    .join('')
}

describe('IncrementalJsonScanner paths', () => {
  it('reports string values at the right paths', () => {
    const seen: [string, string][] = []
    const scanner = new IncrementalJsonScanner({
      onStringEnd: (path, value) => seen.push([path, value]),
    })
    scanner.feed('{"title":"T","chapters":[{"heading":"H1","text":"B1"},{"heading":"H2"}]}')
    expect(seen).toEqual([
      ['title', 'T'],
      ['chapters[0].heading', 'H1'],
      ['chapters[0].text', 'B1'],
      ['chapters[1].heading', 'H2'],
    ])
  })

  it('reports scalars, including nulls', () => {
    const seen: [string, unknown][] = []
    const scanner = new IncrementalJsonScanner({ onScalar: (p, v) => seen.push([p, v]) })
    scanner.feed('{"subtitle":null,"estimated_read_minutes":10,"ok":true}')
    expect(seen).toEqual([
      ['subtitle', null],
      ['estimated_read_minutes', 10],
      ['ok', true],
    ])
  })

  it('decodes escapes, including \\n and \\uXXXX', () => {
    let value = ''
    const scanner = new IncrementalJsonScanner({ onStringEnd: (_p, v) => (value = v) })
    scanner.feed('{"text":"a\\nb \\"q\\" \\\\ \\u00e9"}')
    expect(value).toBe('a\nb "q" \\ é')
  })

  it('survives a chunk boundary inside an escape sequence', () => {
    let value = ''
    const scanner = new IncrementalJsonScanner({ onStringEnd: (_p, v) => (value = v) })
    for (const char of '{"text":"a\\u00e9b"}') scanner.feed(char)
    expect(value).toBe('aéb')
  })

  it('reports object and array boundaries at the container path', () => {
    const seen: string[] = []
    const scanner = new IncrementalJsonScanner({
      onArrayStart: (p) => seen.push(`[+${p}]`),
      onArrayEnd: (p) => seen.push(`[-${p}]`),
      onObjectStart: (p) => seen.push(`{+${p}}`),
      onObjectEnd: (p) => seen.push(`{-${p}}`),
    })
    scanner.feed('{"chapters":[{"a":1}]}')
    expect(seen).toEqual(['{+}', '[+chapters]', '{+chapters[0]}', '{-chapters[0]}', '[-chapters]', '{-}'])
  })
})

describe('StoryStreamParser event order', () => {
  const json = JSON.stringify(goodStory())

  for (const chunkSize of [1, 7, 400, json.length]) {
    it(`produces the same events at a chunk size of ${chunkSize}`, () => {
      const events = runParser(json, chunkSize)
      const story = goodStory()

      // meta is first, before any prose.
      expect(events[0]).toEqual({
        t: 'meta',
        title: story.title,
        subtitle: story.subtitle,
      })

      // One start and one end per chapter, in order.
      const starts = events.filter((e) => e.t === 'start')
      const ends = events.filter((e) => e.t === 'end')
      expect(starts).toHaveLength(story.chapters.length)
      expect(ends).toHaveLength(story.chapters.length)
      expect(starts.map((e) => (e as { index: number }).index)).toEqual(
        story.chapters.map((_, i) => i),
      )

      // Each chapter's deltas reassemble to exactly its text.
      for (const [i, chapter] of story.chapters.entries()) {
        expect(chapterText(events, i), `chapter ${i}`).toBe(chapter.text)
      }

      // A chapter's deltas never precede its start, and its end comes last.
      for (let i = 0; i < story.chapters.length; i += 1) {
        const startAt = events.findIndex((e) => e.t === 'start' && e.index === i)
        const firstDelta = events.findIndex((e) => e.t === 'delta' && e.index === i)
        const endAt = events.findIndex((e) => e.t === 'end' && e.index === i)
        expect(startAt, `chapter ${i} start`).toBeGreaterThanOrEqual(0)
        expect(firstDelta, `chapter ${i} delta after start`).toBeGreaterThan(startAt)
        expect(endAt, `chapter ${i} end last`).toBeGreaterThan(firstDelta)
      }

      // shout_line comes back, including the nulls.
      expect((ends[0] as { shout: string | null }).shout).toBe('PLAY WELL!')
      expect((ends[1] as { shout: string | null }).shout).toBeNull()
    })
  }

  it('emits meta from the title alone when subtitle is absent', () => {
    const events = runParser('{"title":"T","chapters":[{"heading":"H","text":"x"}]}', 3)
    expect(events[0]).toEqual({ t: 'meta', title: 'T', subtitle: null })
  })

  it('holds text deltas until the heading arrives, if the model writes text first', () => {
    const events = runParser(
      '{"title":"T","chapters":[{"text":"body text","heading":"H","shout_line":null}]}',
      4,
    )
    const startAt = events.findIndex((e) => e.t === 'start')
    const firstDelta = events.findIndex((e) => e.t === 'delta')
    expect(firstDelta).toBeGreaterThan(startAt)
    expect((events[startAt] as { heading: string }).heading).toBe('H')
    expect(chapterText(events, 0)).toBe('body text')
  })

  it('closes a truncated chapter rather than leaving the client hanging', () => {
    // The model was cut off mid-story: the last chapter never closes.
    const events = runParser('{"title":"T","chapters":[{"heading":"H","text":"half a cha', 5)
    expect(events.filter((e) => e.t === 'end')).toHaveLength(1)
    expect(chapterText(events, 0)).toBe('half a cha')
  })

  it('keeps the raw text for the authoritative parse', () => {
    const parser = new StoryStreamParser({
      onMeta: () => {},
      onChapterStart: () => {},
      onChapterDelta: () => {},
      onChapterEnd: () => {},
    })
    parser.feed('{"title":')
    parser.feed('"T"}')
    expect(parser.text).toBe('{"title":"T"}')
  })
})

describe('F6 VT: the story parser', () => {
  it('accepts a valid story JSON', () => {
    const result = parseStoryOutputLocal(JSON.stringify(goodStory()))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.story.title).toContain('Brick That Clicked')
  })

  it('rejects one missing true_facts', () => {
    const story = goodStory() as unknown as Record<string, unknown>
    delete story.true_facts
    const result = parseStoryOutputLocal(JSON.stringify(story))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('schema_invalid')
      expect(result.issues.join()).toContain('true_facts')
    }
  })

  it('repairs a JSON wrapped in ```json fences with no model call', () => {
    const fenced = '```json\n' + JSON.stringify(goodStory()) + '\n```'
    const result = parseStoryOutputLocal(fenced)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.repaired).toBe(false)
  })

  it('recovers a JSON object wrapped in commentary', () => {
    const noisy = `Here is the story you asked for:\n${JSON.stringify(goodStory())}\nLet me know!`
    expect(parseStoryOutputLocal(noisy).ok).toBe(true)
  })

  it('reports not_json when there is no object at all', () => {
    const result = parseStoryOutputLocal('I cannot write that story.')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_json')
  })
})

describe('the SSE channel', () => {
  it('encodes an event as one data: line', () => {
    const event: SseEvent = { type: 'chapter_start', index: 0, heading: 'Chapter 1' }
    expect(encodeSse(event)).toBe(`data: ${JSON.stringify(event)}\n\n`)
  })

  it('validates events against lib/schemas/api.ts, so lane 4 never sees a surprise', () => {
    const channel = new SseChannel()
    expect(() =>
      channel.push({ type: 'chapter_start', index: 'nope' } as unknown as SseEvent),
    ).toThrow(/lib\/schemas\/api\.ts/)
  })

  it('resolves waitForOpen once the first event is queued', async () => {
    const channel = new SseChannel()
    let opened = false
    const wait = channel.waitForOpen().then(() => (opened = true))
    expect(opened).toBe(false)
    channel.push({ type: 'chapter_start', index: 0, heading: 'H' })
    await wait
    expect(opened).toBe(true)
    expect(channel.isOpen).toBe(true)
  })

  it('rejects waitForOpen on a pre-stream failure, so the route can answer 502', async () => {
    const channel = new SseChannel()
    const payload = { error: { code: 'generation_failed' }, status: 502 }
    channel.fail(payload)
    await expect(channel.waitForOpen()).rejects.toBe(payload)
  })

  it('turns a post-stream failure into a queued error event instead', async () => {
    const channel = new SseChannel()
    channel.push({ type: 'chapter_start', index: 0, heading: 'H' })
    // Already open: fail() must not reject the (already resolved) open promise.
    channel.fail(new Error('too late'))
    await expect(channel.waitForOpen()).resolves.toBeUndefined()
  })

  it('streams queued events then closes', async () => {
    const channel = new SseChannel()
    channel.push({ type: 'chapter_start', index: 0, heading: 'One' })
    channel.push({ type: 'chapter_end', index: 0, shout_line: null })
    channel.close()
    const chunks: string[] = []
    const reader = channel.toReadableStream().getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value))
    }
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toContain('"heading":"One"')
  })
})
