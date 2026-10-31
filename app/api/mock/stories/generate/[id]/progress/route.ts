import { initialStreamState, streamReducer, type StreamState } from '@/lib/client/generate'
import { compactEvents } from '@/lib/generate/progress'
import { json, withSession } from '@/lib/mock/store'
import type { SseEvent } from '@/lib/schemas'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** One more chapter of a dropped story every this long, as the writer goes on writing. */
const MOCK_CHAPTER_MS = 1_500

/**
 * Mock `GET /api/stories/generate/:id/progress?after=N` (issue #82): the story so far for a
 * page that lost its stream. A dropped story goes on being written here, a chapter every 1.5 s
 * after the drop, and ends as the request ended; the snapshot is folded as the real recorder
 * folds it (`compactEvents`), with one version per chapter released.
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params
  const after = Number(new URL(req.url).searchParams.get('after') ?? 0) || 0
  return withSession(req, ({ state }) => {
    const request = state.generations.get(id.toLowerCase())
    if (!request) return json({ code: 'not_found', message: 'Request not found.' }, { status: 404 })
    if (!request.resume) return json({ ...request, version: 0, events: null })

    const { events, startedAt, chaptersSent } = request.resume as { events: SseEvent[]; startedAt: number; chaptersSent: number }
    const chapterEnds = events.flatMap((e, i) => (e.type === 'chapter_end' ? [i] : []))
    const released = chaptersSent + Math.floor((Date.now() - startedAt) / MOCK_CHAPTER_MS)
    const whole = released >= chapterEnds.length + 1
    // Through the last released chapter's end; the terminal event once every chapter is out.
    const upTo = whole ? events.length : (chapterEnds[Math.min(released, chapterEnds.length) - 1] ?? -1) + 1
    const prefix = events.slice(0, upTo)
    const last = prefix.at(-1)
    const terminal = last && (last.type === 'done' || last.type === 'error') ? last : null
    const folded = prefix.reduce<StreamState>((s, event) => streamReducer(s, { kind: 'event', event }), { ...initialStreamState, phase: 'streaming' })
    const version = Math.min(released, chapterEnds.length + 1)
    return json({
      status: whole ? request.status : 'writing',
      story_id: whole ? request.story_id : null,
      version,
      events: version > after ? compactEvents(folded, terminal) : null,
    })
  })
}
