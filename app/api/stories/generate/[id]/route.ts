import { currentFamilyIfAny } from '@/lib/auth/session'
import { apiError, apiOk } from '@/lib/http/responses'
import { readGenerationRequest } from '@/lib/generate/requests'
import { supabaseService } from '@/lib/supabase/service'

/**
 * GET /api/stories/generate/:id -> { status, story_id } (issue #59). Zero model calls.
 *
 * `:id` is the `x-generation-id` the page sent with its request. A page whose story stream
 * dropped asks this until the request has ended: `writing`, then `ready`/`flagged` with the
 * saved story's id, or `discarded`/`failed`/`refused` (nothing saved, no story used).
 * Another family's id is indistinguishable from a missing one: both 404.
 */
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const ctx = await currentFamilyIfAny()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const { id } = await params
  try {
    // Service role: the table has no policies; the family filter is the access check.
    const request = await readGenerationRequest(supabaseService(), ctx.family.id, id)
    if (!request) return apiError('not_found', 'Request not found.')
    return apiOk(request)
  } catch (err) {
    console.error('[generate] request read failed:', err)
    return apiError('server_error', 'We could not check on that story.')
  }
}
