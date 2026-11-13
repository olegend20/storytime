import type { NextRequest } from 'next/server'
import { currentUserIsOwner } from '@/lib/admin/gate'
import { apiError, readJsonBody } from '@/lib/http/responses'
import { supabaseService } from '@/lib/supabase/service'
import { handleApprove } from '@/lib/waitlist/handlers'
import { waitlistMail } from '@/lib/waitlist/invite'

/**
 * Issue #92 - the owner approves a waitlist address (and the invite email goes out).
 *
 * POST /api/admin/waitlist { email } -> { approved, emailed, alreadyInvited }
 *
 * Anyone but the owner gets a 404, like /admin itself (F12): the route must not reveal
 * that it exists. The invite links to SITE_URL when set, so approving from a preview
 * deployment or localhost still sends parents to lastten.org.
 */
export async function POST(request: NextRequest) {
  if (!(await currentUserIsOwner())) return apiError('not_found', 'Not found.')

  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')

  return handleApprove({ service: supabaseService(), ...waitlistMail(request.nextUrl.origin) }, body)
}
