import { currentFamilyIfAny } from '@/lib/auth/session'
import { apiError, apiOk } from '@/lib/http/responses'
import { readGenerationProgress } from '@/lib/generate/progress'
import { supabaseService } from '@/lib/supabase/service'

/**
 * GET /api/stories/generate/:id/progress?after=N -> { status, story_id, version, events } (issue #82).
 * Zero model calls.
 *
 * A page whose story stream dropped (a locked phone, a switched app) asks this until the
 * request has ended, and carries on from the story so far: `events` is the stream folded to a
 * compact list, sent only when its `version` is newer than the page's `after`. `status` and
 * `story_id` are #59's (`GET /api/stories/generate/:id`). Another family's id is a 404.
 */
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: Request, { params }: Ctx) {
  const ctx = await currentFamilyIfAny()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const { id } = await params
  const raw = Number(new URL(req.url).searchParams.get('after') ?? 0)
  const after = Number.isInteger(raw) && raw >= 0 ? raw : 0
  try {
    // Service role: the tables have no policies; the family filter is the access check.
    const progress = await readGenerationProgress(supabaseService(), ctx.family.id, id, after)
    if (!progress) return apiError('not_found', 'Request not found.')
    return apiOk(progress)
  } catch (err) {
    console.error('[generate] progress read failed:', err)
    return apiError('server_error', 'We could not check on that story.')
  }
}
