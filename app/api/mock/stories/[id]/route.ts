import { json, withSession } from '@/lib/mock/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Mock `GET /api/stories/:id`.
 *
 * Reads stored content only. F9's AC is that opening a saved story makes zero model calls, so
 * this handler deliberately never touches `state.modelCalls` - and e2e reads that counter to
 * prove it rather than taking it on trust.
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params
  return withSession(req, ({ state }) => {
    const story = state.stories.get(id)
    if (!story) return json({ code: 'not_found', message: 'Story not found.' }, { status: 404 })
    return json({ story })
  })
}

/** Mock `DELETE /api/stories/:id`. F9: the story goes; the Story Bible is NOT rolled back. */
export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params
  return withSession(req, ({ state }) => {
    if (!state.stories.delete(id)) {
      return json({ code: 'not_found', message: 'Story not found.' }, { status: 404 })
    }
    return new Response(null, { status: 204 })
  })
}
