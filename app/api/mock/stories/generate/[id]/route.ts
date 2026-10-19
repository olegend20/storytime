import { json, withSession } from '@/lib/mock/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/** Mock `GET /api/stories/generate/:id` (issue #59): how a request ended, by the page's id. */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params
  return withSession(req, ({ state }) => {
    const request = state.generations.get(id.toLowerCase())
    if (!request) return json({ code: 'not_found', message: 'Request not found.' }, { status: 404 })
    return json(request)
  })
}
