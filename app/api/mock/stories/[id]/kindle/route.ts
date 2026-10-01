import { json, withSession } from '@/lib/mock/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Mock `POST /api/stories/:id/kindle` (issue #11). The mock family has a Kindle address
 * unless the story id ends in "0" - which lets the UI's "add it in Settings" path be seen.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params
  return withSession(req, ({ state }) => {
    const story = state.stories.get(id)
    if (!story) return json({ code: 'not_found', message: 'Story not found.' }, { status: 404 })
    if (id.endsWith('0')) {
      return json({ code: 'no_kindle_address', message: 'Add your Kindle address in Settings first.' }, { status: 400 })
    }
    return json({ sent: { to: 'mock_family@kindle.com', filename: 'story.epub', sent_today: 1 } })
  })
}
