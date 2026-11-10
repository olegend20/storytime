import type { NextRequest } from 'next/server'
import { isOwner } from '@/lib/admin/gate'
import { apiError, readJsonBody } from '@/lib/http/responses'
import { supabaseServer } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { handleApprove } from '@/lib/waitlist/handlers'
import { smtpInviteSender } from '@/lib/waitlist/invite'

/**
 * Issue #92 - the owner approves a waitlist address (and the invite email goes out).
 *
 * POST /api/admin/waitlist { email } -> { approved, emailed, alreadyInvited }
 *
 * Anyone but the owner gets a 404, like /admin itself (F12): the route must not reveal
 * that it exists.
 */
export async function POST(request: NextRequest) {
  let userId: string | null = null
  try {
    const { data } = await (await supabaseServer()).auth.getUser()
    userId = data.user?.id ?? null
  } catch {
    userId = null
  }
  if (!isOwner(userId)) return apiError('not_found', 'Not found.')

  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')

  let sender = null
  try {
    sender = smtpInviteSender()
  } catch {
    sender = null
  }
  return handleApprove({ service: supabaseService(), sender, origin: request.nextUrl.origin }, body)
}
