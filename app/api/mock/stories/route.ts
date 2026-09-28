import { json, withSession } from '@/lib/mock/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Mock `GET /api/stories` - the F9 library list, newest first. */
export async function GET(req: Request): Promise<Response> {
  return withSession(req, ({ state }) => {
    const stories = [...state.stories.values()].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    )
    return json({ stories })
  })
}
