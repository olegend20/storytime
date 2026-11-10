import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, apiOk } from '@/lib/http/responses'
import { normalizeEmail } from './email'
import { inviteFromAddress, inviteMail, type InviteSender } from './invite'
import { approve, isApproved, joinWaitlist, markInvited } from './store'

/**
 * The three waitlist route bodies (issue #92), kept out of `app/` so the integration tests
 * can drive them against the local database with the real Supabase clients.
 */

const BAD_EMAIL = 'Please enter an email address we can write to.'

function readBody(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
}

// ---------------------------------------------------------------- join

/**
 * POST /api/waitlist. The answer is the same whether the address is new, already waiting or
 * already approved: the page must not tell a stranger who has signed up.
 *
 * `website` is a honeypot: a field people never see, which form-filling bots fill. Such a
 * request is answered exactly like a real one and stored nowhere.
 */
export async function handleJoinWaitlist(db: SupabaseClient, body: unknown): Promise<Response> {
  const input = readBody(body)
  const email = normalizeEmail(input?.email)
  if (!email) return apiError('invalid_request', BAD_EMAIL, { field: 'email' })
  if (typeof input?.website === 'string' && input.website.trim() !== '') return apiOk({ joined: true })
  try {
    await joinWaitlist(db, email)
  } catch (cause) {
    console.error('[waitlist] join failed', cause)
    return apiError('server_error', 'We could not add you just now. Please try again in a moment.')
  }
  return apiOk({ joined: true })
}

// ---------------------------------------------------------------- sign in / sign up

export type SignInStatus = 'sent' | 'not_approved'

export interface SignInDeps {
  /** Sends the magic link. Must NOT create a user: `shouldCreateUser: false`. */
  sendLink: (email: string) => Promise<{ error: { code?: string; status?: number; message: string } | null }>
  /** Service-role client: reads the waitlist and creates approved accounts. */
  service: SupabaseClient
  waitlistOn: boolean
}

/** What GoTrue answers when a link is asked for an address with no account and no sign-up. */
const NO_ACCOUNT_CODES = new Set(['otp_disabled', 'signup_disabled', 'user_not_found'])

/**
 * POST /api/auth/email - the only way an account is created (issue #92).
 *
 * Supabase's own sign-up is switched off (supabase/config.toml, and the dashboard toggle in
 * production), so a browser cannot create a user by talking to Supabase directly. Here:
 *
 *  1. Ask for a link without creating anyone. An existing account - approved or from before
 *     the waitlist - gets it, and that is the end of it.
 *  2. No account: with the waitlist on, only an approved address continues; anyone else is
 *     told to join the waitlist. With it off, everyone continues.
 *  3. Create the account with the service role (confirmed: the link proves the inbox), then
 *     send the link.
 */
export async function handleSignInEmail(deps: SignInDeps, body: unknown): Promise<Response> {
  const email = normalizeEmail(readBody(body)?.email)
  if (!email) return apiError('invalid_request', BAD_EMAIL, { field: 'email' })

  const failed = () =>
    apiError('server_error', 'We could not send that link just now. Please try again in a moment.')

  const first = await deps.sendLink(email)
  if (!first.error) return apiOk({ status: 'sent' satisfies SignInStatus })
  if (!NO_ACCOUNT_CODES.has(first.error.code ?? '')) {
    console.error('[auth/email] sign-in link failed', first.error.code, first.error.status)
    return first.error.status === 429
      ? apiError('rate_limited', 'Too many links asked for just now. Please wait a minute and try again.')
      : failed()
  }

  try {
    if (deps.waitlistOn && !(await isApproved(deps.service, email))) {
      return apiOk({ status: 'not_approved' satisfies SignInStatus })
    }
  } catch (cause) {
    console.error('[auth/email] waitlist lookup failed', cause)
    return failed()
  }

  const created = await deps.service.auth.admin.createUser({ email, email_confirm: true })
  // A second request racing this one may have created the account already; the link below
  // works either way.
  if (created.error && !/already/i.test(created.error.message)) {
    console.error('[auth/email] account creation failed', created.error.status)
    return failed()
  }

  const second = await deps.sendLink(email)
  if (second.error) {
    console.error('[auth/email] sign-in link failed after sign-up', second.error.code, second.error.status)
    return failed()
  }
  return apiOk({ status: 'sent' satisfies SignInStatus })
}

// ---------------------------------------------------------------- owner: approve

export interface ApproveDeps {
  service: SupabaseClient
  /** Null when mail is not set up: the approval still happens, and the page says no email went. */
  sender: InviteSender | null
  /** The site the owner is on, for the link in the email. */
  origin: string
}

/**
 * POST /api/admin/waitlist { email }. The route has already 404'd anyone but the owner.
 * The invite goes once: pressing Approve again only resends one that never went out (mail
 * was not set up, or the send failed).
 */
export async function handleApprove(deps: ApproveDeps, body: unknown): Promise<Response> {
  const email = normalizeEmail(readBody(body)?.email)
  if (!email) return apiError('invalid_request', BAD_EMAIL, { field: 'email' })

  let invited: boolean
  try {
    ;({ invited } = await approve(deps.service, email))
  } catch (cause) {
    console.error('[admin/waitlist] approve failed', cause)
    return apiError('server_error', 'Could not approve that address. Try again.')
  }
  if (invited) return apiOk({ approved: true, emailed: false, alreadyInvited: true })

  const from = inviteFromAddress()
  if (!deps.sender || !from) return apiOk({ approved: true, emailed: false, alreadyInvited: false })
  try {
    await deps.sender.send(inviteMail(email, from, deps.origin))
    await markInvited(deps.service, email)
    return apiOk({ approved: true, emailed: true, alreadyInvited: false })
  } catch (cause) {
    console.error('[admin/waitlist] invite email failed', cause)
    return apiOk({ approved: true, emailed: false, alreadyInvited: false })
  }
}
