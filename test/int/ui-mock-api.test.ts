import { beforeAll, describe, expect, it } from 'vitest'
import { QuotaResponse, SseEvent, SuggestedTopicsResponse } from '@/lib/schemas'
import { LibraryResponse, StoryResponse } from '@/lib/client/types'
import { MOCK_SESSION_COOKIE } from '@/lib/mock/store'
import { SseFrameParser } from '@/lib/client/sse'

/**
 * The mock backend, exercised as HTTP.
 *
 * Route handlers are plain `(Request) => Response` functions, so they can be called directly -
 * no server, no port, no flake. These are the F9/F10 integration VTs: delete → 404 with siblings
 * intact, the SSE event order from `lib/schemas/api.ts`, and the two failure shapes.
 *
 * The mock is lane 4's stand-in for lane 2's `/api/stories/generate`. When the real route lands,
 * the e2e suite points at `/api/*` by dropping `NEXT_PUBLIC_API_MOCK` and these tests keep
 * covering the fixture path.
 */

process.env.UI_MOCK_API = '1'
// No artificial stream delay: these tests assert order and payloads, not timing.
process.env.UI_MOCK_STREAM_DELAY_MS = '0'

type Handler = (req: Request, ctx?: unknown) => Promise<Response>

let quotaGET: Handler
let topicsGET: Handler
let childrenGET: Handler
let storiesGET: Handler
let storyGET: Handler
let storyDELETE: Handler
let generatePOST: Handler
let debugGET: Handler
let debugPOST: Handler

beforeAll(async () => {
  quotaGET = (await import('@/app/api/mock/quota/route')).GET as Handler
  topicsGET = (await import('@/app/api/mock/topics/suggested/route')).GET as Handler
  childrenGET = (await import('@/app/api/mock/children/route')).GET as Handler
  storiesGET = (await import('@/app/api/mock/stories/route')).GET as Handler
  const story = await import('@/app/api/mock/stories/[id]/route')
  storyGET = story.GET as Handler
  storyDELETE = story.DELETE as Handler
  generatePOST = (await import('@/app/api/mock/stories/generate/route')).POST as Handler
  const debug = await import('@/app/api/mock/debug/route')
  debugGET = debug.GET as Handler
  debugPOST = debug.POST as Handler
})

/** One isolated mock session per test, the same way a browser context gets one. */
function session(id: string) {
  const cookie = `${MOCK_SESSION_COOKIE}=${id}`
  const req = (url: string, init?: RequestInit) =>
    new Request(`http://localhost${url}`, {
      ...init,
      headers: { cookie, ...(init?.headers ?? {}) },
    })
  return {
    quota: () => quotaGET(req('/api/mock/quota')),
    topics: () => topicsGET(req('/api/mock/topics/suggested')),
    children: () => childrenGET(req('/api/mock/children')),
    stories: () => storiesGET(req('/api/mock/stories')),
    story: (storyId: string) =>
      storyGET(req(`/api/mock/stories/${storyId}`), { params: Promise.resolve({ id: storyId }) }),
    deleteStory: (storyId: string) =>
      storyDELETE(req(`/api/mock/stories/${storyId}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id: storyId }),
      }),
    generate: (body: unknown) =>
      generatePOST(
        req('/api/mock/stories/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
    debug: () => debugGET(req('/api/mock/debug')),
    patch: (patch: unknown) =>
      debugPOST(
        req('/api/mock/debug', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }),
      ),
  }
}

const CRUZ = 'c1111111-1111-4111-8111-111111111111'
const PHOENIX = 'c2222222-2222-4222-8222-222222222222'

function generateBody(topic: string, extra: Record<string, unknown> = {}) {
  return {
    child_ids: [CRUZ, PHOENIX],
    topic_input: topic,
    tones: ['funny', 'exciting'],
    length_minutes: 10,
    ...extra,
  }
}

/** Collect an SSE response into validated events plus a count of unknown ones. */
async function collect(res: Response) {
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const body = res.body
  if (!body) throw new Error('no stream body')
  const parser = new SseFrameParser()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  const unknown: unknown[] = []
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
      const raw: unknown = JSON.parse(frame)
      const parsed = SseEvent.safeParse(raw)
      if (parsed.success) events.push(parsed.data)
      else unknown.push(raw)
    }
  }
  return { events, unknown }
}

describe('mock GET endpoints match the contract', () => {
  it('quota', async () => {
    const res = await session('quota').quota()
    expect(res.status).toBe(200)
    const quota = QuotaResponse.parse(await res.json())
    expect(quota.limit).toBe(3)
    expect(quota.used).toBeLessThanOrEqual(quota.limit)
  })

  it('suggested topics (deliberately fewer than 8, so the UI has to top up)', async () => {
    const res = await session('topics').topics()
    const topics = SuggestedTopicsResponse.parse(await res.json())
    expect(topics.topics.length).toBeLessThan(8)
    expect(topics.topics.every((t) => t.warm)).toBe(true)
  })

  it('children carry only the five allowed fields (F11)', async () => {
    const res = await session('children').children()
    const body = (await res.json()) as { children: Record<string, unknown>[] }
    expect(body.children.length).toBeGreaterThan(0)
    const allowed = new Set([
      'id',
      'family_id',
      'first_name',
      'age',
      'likes',
      'notes',
      'reading_level',
    ])
    for (const child of body.children) {
      for (const key of Object.keys(child)) expect(allowed.has(key), key).toBe(true)
    }
  })

  it('library list is newest first', async () => {
    const res = await session('list').stories()
    const { stories } = LibraryResponse.parse(await res.json())
    const times = stories.map((s) => Date.parse(s.created_at))
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('mock routes 404 when UI_MOCK_API is not set', async () => {
    process.env.UI_MOCK_API = '0'
    try {
      expect((await session('off').quota()).status).toBe(404)
    } finally {
      process.env.UI_MOCK_API = '1'
    }
  })
})

describe('F9 VT (int): delete story → 404 on its URL; other stories in the series intact', () => {
  it('removes only the deleted story', async () => {
    const s = session('delete-one')
    const { stories } = LibraryResponse.parse(await (await s.stories()).json())
    const seriesWithTwo = stories.find(
      (story) => stories.filter((other) => other.series_id === story.series_id).length > 1,
    )
    expect(seriesWithTwo, 'fixtures need a series with two stories').toBeDefined()
    if (!seriesWithTwo) return
    const sibling = stories.find(
      (story) => story.series_id === seriesWithTwo.series_id && story.id !== seriesWithTwo.id,
    )
    expect(sibling).toBeDefined()

    expect((await s.story(seriesWithTwo.id)).status).toBe(200)
    expect((await s.deleteStory(seriesWithTwo.id)).status).toBe(204)
    expect((await s.story(seriesWithTwo.id)).status).toBe(404)

    if (sibling) {
      const siblingRes = await s.story(sibling.id)
      expect(siblingRes.status).toBe(200)
      const parsed = StoryResponse.parse(await siblingRes.json())
      expect(parsed.story.id).toBe(sibling.id)
    }
    const after = LibraryResponse.parse(await (await s.stories()).json())
    expect(after.stories.map((x) => x.id)).not.toContain(seriesWithTwo.id)
    expect(after.stories).toHaveLength(stories.length - 1)
  })

  it('deleting twice is a 404, not a 500', async () => {
    const s = session('delete-twice')
    const { stories } = LibraryResponse.parse(await (await s.stories()).json())
    const id = stories[0]?.id ?? ''
    expect((await s.deleteStory(id)).status).toBe(204)
    expect((await s.deleteStory(id)).status).toBe(404)
  })
})

describe('F9 AC: opening a saved story makes zero model calls', () => {
  it('reading and re-reading never increments the model-call counter', async () => {
    const s = session('zero-calls')
    const { stories } = LibraryResponse.parse(await (await s.stories()).json())
    const id = stories[0]?.id ?? ''
    const before = (await (await s.debug()).json()) as { model_calls: number }
    for (let i = 0; i < 3; i++) expect((await s.story(id)).status).toBe(200)
    await s.stories()
    const after = (await (await s.debug()).json()) as { model_calls: number }
    expect(after.model_calls).toBe(before.model_calls)
    expect(after.model_calls).toBe(0)
  })
})

describe('generate: the happy path follows the event order in lib/schemas/api.ts', () => {
  it('meta → per chapter (start, delta+, end) → done', async () => {
    const s = session('happy')
    await s.patch({ reset: true })
    const res = await s.generate(generateBody('the history of soccer'))
    expect(res.status).toBe(200)
    const { events, unknown } = await collect(res)
    expect(unknown).toEqual([])

    expect(events[0]?.type).toBe('meta')
    expect(events[events.length - 1]?.type).toBe('done')

    // Every chapter opens before its deltas and closes after them, in index order.
    const byChapter = new Map<number, string[]>()
    let expectedIndex = 0
    for (const event of events) {
      if (event.type === 'chapter_start') {
        expect(event.index).toBe(expectedIndex)
        expectedIndex += 1
        expect(event.heading.length).toBeGreaterThan(0)
        byChapter.set(event.index, ['start'])
      } else if (event.type === 'chapter_delta') {
        expect(byChapter.get(event.index)?.[0]).toBe('start')
        byChapter.get(event.index)?.push('delta')
      } else if (event.type === 'chapter_end') {
        byChapter.get(event.index)?.push('end')
      }
    }
    expect(byChapter.size).toBeGreaterThanOrEqual(6)
    for (const [index, sequence] of byChapter) {
      expect(sequence[0], `chapter ${index}`).toBe('start')
      expect(sequence[sequence.length - 1], `chapter ${index}`).toBe('end')
      expect(sequence.filter((s) => s === 'delta').length, `chapter ${index}`).toBeGreaterThan(1)
    }

    const done = events[events.length - 1]
    if (done?.type !== 'done') throw new Error('expected done')
    // The deltas, concatenated, are exactly the final story - nothing lost, nothing doubled.
    for (const [index, chapter] of done.story.chapters.entries()) {
      const streamed = events
        .filter((e) => e.type === 'chapter_delta' && e.index === index)
        .map((e) => (e.type === 'chapter_delta' ? e.text : ''))
        .join('')
      expect(streamed).toBe(chapter.text)
    }
    expect(done.story.true_facts.length).toBeGreaterThanOrEqual(8)
    expect(done.quota.used).toBeLessThanOrEqual(done.quota.limit)
  })

  it('consumes exactly one story of quota and one model call, and saves the story', async () => {
    const s = session('quota-move')
    await s.patch({ reset: true, quota_used: 0, model_calls: 0 })
    const res = await s.generate(generateBody('how bees make honey'))
    const { events } = await collect(res)
    const meta = events[0]
    if (meta?.type !== 'meta') throw new Error('expected meta first')

    const after = (await (await s.debug()).json()) as { quota_used: number; model_calls: number }
    expect(after.quota_used).toBe(1)
    expect(after.model_calls).toBe(1)

    // The story is readable immediately, with zero further model calls.
    const saved = await s.story(meta.story_id)
    expect(saved.status).toBe(200)
    const reread = (await (await s.debug()).json()) as { model_calls: number }
    expect(reread.model_calls).toBe(1)
  })

  it('a band A request gets band A word targets, taken from the request not the fixture', async () => {
    const s = session('band')
    await s.patch({ reset: true, quota_used: 0 })
    const { events } = await collect(await s.generate(generateBody('volcanoes')))
    const meta = events[0]
    if (meta?.type !== 'meta') throw new Error('expected meta')
    // Phoenix is 4, so the youngest sets band A (§4.5).
    expect(meta.age_band).toBe('A')
    expect(meta.target_words).toEqual({ min: 1300, max: 1700 })
  })

  it('a 5-minute request scales the target linearly (§4.5)', async () => {
    const s = session('short')
    await s.patch({ reset: true, quota_used: 0 })
    const { events } = await collect(
      await s.generate(generateBody('dinosaurs', { length_minutes: 5 })),
    )
    const meta = events[0]
    if (meta?.type !== 'meta') throw new Error('expected meta')
    expect(meta.target_words).toEqual({ min: 650, max: 850 })
  })

  it('tolerates an event type this build does not know', async () => {
    const s = session('unknown')
    await s.patch({ reset: true, quota_used: 0 })
    const { events, unknown } = await collect(await s.generate(generateBody('!unknownevent bees')))
    expect(unknown).toHaveLength(1)
    // The known events are unaffected by the one in the middle.
    expect(events[0]?.type).toBe('meta')
    expect(events[events.length - 1]?.type).toBe('done')
  })
})

describe('generate: failures, and what they cost', () => {
  it('a refused topic is a pre-stream 422 with quota_consumed false and no model call', async () => {
    const s = session('refuse')
    await s.patch({ reset: true, quota_used: 0, model_calls: 0 })
    const res = await s.generate(generateBody('!refuse something'))
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('topic_refused')
    expect(body.quota_consumed).toBe(false)
    expect(String(body.message).length).toBeGreaterThan(10)
    // GUARDRAILS.md §5: never echo the input, never name the layer.
    expect(String(body.message)).not.toContain('!refuse')

    const after = (await (await s.debug()).json()) as { quota_used: number; model_calls: number }
    expect(after.quota_used).toBe(0)
    expect(after.model_calls).toBe(0)
  })

  it('too mature for the band is a 422, also free', async () => {
    const s = session('mature')
    const res = await s.generate(generateBody('!mature topic'))
    expect(res.status).toBe(422)
    expect(((await res.json()) as { quota_consumed: boolean }).quota_consumed).toBe(false)
  })

  it('service paused and budget exceeded are 503', async () => {
    const s = session('paused')
    expect((await s.generate(generateBody('!paused x'))).status).toBe(503)
    expect((await s.generate(generateBody('!budget x'))).status).toBe(503)
  })

  it('an exhausted quota is a 429 that says when it resets', async () => {
    const s = session('exhausted')
    await s.patch({ reset: true, quota_used: 3 })
    const res = await s.generate(generateBody('sharks'))
    expect(res.status).toBe(429)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('quota_exceeded')
    expect(body.quota_consumed).toBe(false)
    expect(typeof body.resets_at).toBe('string')
    expect(Number.isNaN(Date.parse(String(body.resets_at)))).toBe(false)
  })

  it('an invalid body is a 400 before anything else', async () => {
    const s = session('invalid')
    const res = await s.generate({ child_ids: [], topic_input: '', tones: [], length_minutes: 7 })
    expect(res.status).toBe(400)
    const after = (await (await s.debug()).json()) as { model_calls: number }
    expect(after.model_calls).toBe(0)
  })

  it('three tones are rejected by the contract, not just by the UI', async () => {
    const s = session('three-tones')
    const res = await s.generate(
      generateBody('sharks', { tones: ['funny', 'exciting', 'silly'] }),
    )
    expect(res.status).toBe(400)
  })

  it('a mid-stream failure arrives as an error event on a 200 and costs no quota', async () => {
    const s = session('midfail')
    await s.patch({ reset: true, quota_used: 0, model_calls: 0 })
    const res = await s.generate(generateBody('!midfail bees'))
    expect(res.status).toBe(200)
    const { events } = await collect(res)
    const last = events[events.length - 1]
    expect(last?.type).toBe('error')
    if (last?.type !== 'error') throw new Error('expected error event')
    expect(last.quota_consumed).toBe(false)
    expect(last.code).toBe('generation_failed')
    // Some prose already arrived, which is exactly why this cannot be a pre-stream failure.
    expect(events.some((e) => e.type === 'chapter_delta')).toBe(true)

    const after = (await (await s.debug()).json()) as { quota_used: number; model_calls: number }
    expect(after.quota_used).toBe(0)
    // The writing call did happen - the cost was real even though the parent is not charged.
    expect(after.model_calls).toBe(1)
  })
})

describe('mock sessions are isolated, so parallel e2e workers cannot interfere', () => {
  it('one session exhausting its quota does not affect another', async () => {
    const a = session('iso-a')
    const b = session('iso-b')
    await a.patch({ reset: true, quota_used: 3 })
    expect((await a.generate(generateBody('sharks'))).status).toBe(429)
    const quotaB = QuotaResponse.parse(await (await b.quota()).json())
    expect(quotaB.used).toBeLessThan(quotaB.limit)
  })

  it('a request with no cookie gets one back', async () => {
    const res = await quotaGET(new Request('http://localhost/api/mock/quota'))
    expect(res.headers.get('set-cookie')).toContain(MOCK_SESSION_COOKIE)
  })
})
