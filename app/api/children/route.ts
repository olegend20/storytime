import { currentFamily } from '@/lib/auth/session'
import { handleCreateChild, handleListChildren } from '@/lib/children/handlers'
import { apiError, readJsonBody } from '@/lib/http/responses'

/**
 * F3 - children collection.
 *
 * GET  /api/children -> { children: [...] }
 * POST /api/children -> 201 { child } | 400 invalid_request | 400 child_limit_reached
 *                       | 400 html_not_allowed
 *
 * Validation runs here as well as in the browser (F3 AC): the client form is a courtesy,
 * the server is the rule. The logic lives in `lib/children/handlers.ts` so the integration
 * tests can drive it directly; the IP rate limit (F11) is applied to every /api route in
 * `proxy.ts`.
 */

export async function GET() {
  const ctx = await currentFamily()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  return handleListChildren({ db: ctx.db, familyId: ctx.family.id })
}

export async function POST(request: Request) {
  const ctx = await currentFamily()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')
  return handleCreateChild({ db: ctx.db, familyId: ctx.family.id }, body)
}
