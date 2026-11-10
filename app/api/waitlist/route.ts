import { after, type NextRequest } from 'next/server'
import { apiError, readJsonBody } from '@/lib/http/responses'
import { supabaseService } from '@/lib/supabase/service'
import { handleJoinWaitlist } from '@/lib/waitlist/handlers'
import { waitlistMail } from '@/lib/waitlist/invite'

/**
 * Issue #92 - join the waitlist from the coming-soon page; issue #95 - and get the email that
 * confirms the address.
 *
 * POST /api/waitlist { email, website? } -> { ok: true }
 *
 * Public, and rate-limited per IP by the proxy in the sign-in bucket.
 */
export async function POST(request: NextRequest) {
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')
  // The email goes after the response, so how long joining takes says nothing about the address.
  return handleJoinWaitlist(
    { service: supabaseService(), ...waitlistMail(request.nextUrl.origin), defer: (task) => after(task) },
    body,
  )
}
