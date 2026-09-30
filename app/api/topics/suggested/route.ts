import { currentFamilyIfAny } from '@/lib/auth/session'
import { apiError, apiOk } from '@/lib/http/responses'
import { suggestedTopics } from '@/lib/stories/library'

/**
 * GET /api/topics/suggested - up to four warm topics (a ready fact pack, so the story starts
 * without a research build). The new-story form pads to eight with evergreen ideas.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const ctx = await currentFamilyIfAny()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  try {
    return apiOk(await suggestedTopics(ctx.db))
  } catch (err) {
    console.error('[topics] suggested failed:', err)
    return apiError('server_error', 'We could not load topic ideas.')
  }
}
