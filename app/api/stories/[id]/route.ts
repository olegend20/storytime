import { currentFamilyIfAny } from '@/lib/auth/session'
import { apiError, apiOk } from '@/lib/http/responses'
import { deleteLibraryStory, getLibraryStory } from '@/lib/stories/library'

/**
 * GET    /api/stories/:id -> { story } (`StoryResponse`). Zero model calls (F9 AC).
 * DELETE /api/stories/:id -> 204. F9: the Story Bible is not rolled back.
 *
 * Another family's id is indistinguishable from a missing one: RLS hides it, so both 404.
 */
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const ctx = await currentFamilyIfAny()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const { id } = await params
  try {
    const story = await getLibraryStory(ctx.db, id)
    if (!story) return apiError('not_found', 'Story not found.')
    return apiOk({ story })
  } catch (err) {
    console.error('[stories] get failed:', err)
    return apiError('server_error', 'We could not load that story.')
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const ctx = await currentFamilyIfAny()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const { id } = await params
  try {
    if (!(await deleteLibraryStory(ctx.db, id))) return apiError('not_found', 'Story not found.')
    return new Response(null, { status: 204 })
  } catch (err) {
    console.error('[stories] delete failed:', err)
    return apiError('server_error', 'We could not delete that story.')
  }
}
