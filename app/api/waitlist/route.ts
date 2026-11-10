import { apiError, readJsonBody } from '@/lib/http/responses'
import { supabaseService } from '@/lib/supabase/service'
import { handleJoinWaitlist } from '@/lib/waitlist/handlers'

/**
 * Issue #92 - join the waitlist from the coming-soon page.
 *
 * POST /api/waitlist { email, website? } -> { joined: true }
 *
 * Public, and rate-limited per IP by the proxy like every `/api/*` route.
 */
export async function POST(request: Request) {
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')
  return handleJoinWaitlist(supabaseService(), body)
}
