import { currentFamily } from '@/lib/auth/session'
import { handleGetFamily, handleUpdateFamily } from '@/lib/family/handlers'
import { apiError, readJsonBody } from '@/lib/http/responses'

/**
 * F2 - family settings.
 *
 * GET   /api/family -> { family: { id, display_name, timezone } }
 * PATCH /api/family -> { family }
 *
 * `owner_user_id` is not patchable and is never read from the body: the RLS policy would
 * reject a change anyway, but not accepting the field at all is one fewer thing to reason
 * about.
 */

export async function GET() {
  const ctx = await currentFamily()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  return handleGetFamily({ db: ctx.db, family: ctx.family })
}

export async function PATCH(request: Request) {
  const ctx = await currentFamily()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')
  return handleUpdateFamily({ db: ctx.db, family: ctx.family }, body)
}
