import { currentFamilyIfAny } from '@/lib/auth/session'
import { apiError, apiOk } from '@/lib/http/responses'
import { listLibrary } from '@/lib/stories/library'

/**
 * GET /api/stories - the F9 library, newest first (`LibraryResponse`).
 * RLS scopes every row to the caller's family; the UI groups by series.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const ctx = await currentFamilyIfAny()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  try {
    return apiOk({ stories: await listLibrary(ctx.db) })
  } catch (err) {
    console.error('[stories] list failed:', err)
    return apiError('server_error', 'We could not load your stories.')
  }
}
