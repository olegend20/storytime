import { apiError, readJsonBody } from '@/lib/http/responses'
import { supabaseService } from '@/lib/supabase/service'
import { handlePrepareSignIn } from '@/lib/waitlist/handlers'
import { waitlistEnabled } from '@/lib/waitlist/mode'

/**
 * Issue #92 - create the account for an address that may have one, before the login form
 * asks Supabase for the link again. See `handlePrepareSignIn`.
 *
 * POST /api/auth/prepare { email } -> { ok: true } (the same for every address)
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')
  return handlePrepareSignIn({ service: supabaseService(), waitlistOn: waitlistEnabled() }, body)
}
