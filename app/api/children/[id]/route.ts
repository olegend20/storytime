import { currentFamily } from '@/lib/auth/session'
import { handleDeleteChild, handleUpdateChild } from '@/lib/children/handlers'
import { apiError, readJsonBody } from '@/lib/http/responses'

/**
 * F3 - one child.
 *
 * PATCH  /api/children/:id -> { child }
 * DELETE /api/children/:id -> { deleted: true, affected_series: n }
 *
 * A child belonging to another family is a 404, not a 403: RLS already makes it invisible,
 * and "not found" does not confirm that the id exists somewhere.
 */

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await currentFamily()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const { id } = await context.params
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')
  return handleUpdateChild({ db: ctx.db, familyId: ctx.family.id }, id, body)
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const ctx = await currentFamily()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const { id } = await context.params
  return handleDeleteChild({ db: ctx.db, familyId: ctx.family.id }, id)
}
