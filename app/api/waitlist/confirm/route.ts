import { apiError, readJsonBody } from '@/lib/http/responses'
import { supabaseService } from '@/lib/supabase/service'
import { handleConfirm } from '@/lib/waitlist/handlers'

/**
 * Issue #95 - confirm a waitlist address, from the button on /waitlist/confirm.
 *
 * POST /api/waitlist/confirm { token } -> { confirmed: true } | 400
 *
 * Public; under /api/waitlist, so the proxy rate-limits it in the sign-in bucket.
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')
  return handleConfirm(supabaseService(), body)
}
