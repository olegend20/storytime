import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, apiOk } from '@/lib/http/responses'
import { normalizeEmail } from './email'
import { inviteFromAddress, inviteMail, type InviteSender } from './invite'
import {
  confirmMail,
  CONFIRM_CAP_WINDOW_MS,
  CONFIRM_EMAILS_PER_DAY,
  CONFIRM_RESEND_AFTER_MS,
  CONFIRM_TTL_MS,
  hashConfirmToken,
  isConfirmToken,
  newConfirmToken,
  UNSENT_TTL_MS,
} from './confirm'
import {
  approve,
  claimConfirmEmail,
  claimInvite,
  confirmEmailsSince,
  confirmByToken,
  isApproved,
  joinWaitlist,
  markConfirmed,
  purgeUnconfirmed,
  releaseConfirmEmail,
  releaseInvite,
} from './store'

/**
 * The waitlist's route bodies (issue #92), kept out of `app/` so the integration tests can
 * drive them against the local database with the real Supabase clients.
 */

const BAD_EMAIL = 'Please enter an email address we can write to.'

function readBody(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
}

// ---------------------------------------------------------------- join

export interface JoinDeps {
  service: SupabaseClient
  /** Null when mail is not set up: the address goes straight onto the list, as before #95. */
  sender: InviteSender | null
  /** The site the confirmation link points at - SITE_URL, or the request's own origin. */
  origin: string
  /** Confirmation emails a day across all addresses; `CONFIRM_EMAILS_PER_DAY` unless a test sets it. */
  dailyCap?: number
  /**
   * Runs the email work after the response has gone (the route passes Next's `after`). Unset,
   * the work is awaited before answering - the tests, which need to see what was sent.
   */
  defer?: (task: () => Promise<void>) => void
}

/**
 * POST /api/waitlist. The answer is the same whether the address is new, already waiting,
 * already approved or was emailed an hour ago: the page must not tell a stranger who has
 * signed up. In production it also takes the same time: everything that differs by address
 * - the claim, the cap, the SMTP send - runs after the response (`defer`).
 *
 * Issue #95: the address reaches the owner's list only once its inbox confirms it, so a new
 * one is emailed a link. The right to send is claimed first - at most one email per address
 * per day, so this form cannot flood a stranger's inbox - and given back if the send fails or
 * the day's cap across everyone is reached (sign-in links share the mail account, and a bot
 * must not be able to spend it). A visitor whose email did not go can join again.
 *
 * `website` is a honeypot: a field people never see, which form-filling bots fill. Such a
 * request is answered exactly like a real one and stored nowhere.
 */
export async function handleJoinWaitlist(deps: JoinDeps, body: unknown): Promise<Response> {
  const input = readBody(body)
  const email = normalizeEmail(input?.email)
  if (!email) return apiError('invalid_request', BAD_EMAIL, { field: 'email' })
  if (typeof input?.website === 'string' && input.website.trim() !== '') return apiOk({ ok: true })
  try {
    // Housekeeping first, so a returning visitor's expired row is replaced, not deleted
    // after they rejoin. Rides on joins: no cron to forget. Its failure never blocks a join.
    await purgeUnconfirmed(deps.service, CONFIRM_TTL_MS, UNSENT_TTL_MS).catch((e) => console.error('[waitlist] purge failed', e))
    await joinWaitlist(deps.service, email)
  } catch (cause) {
    console.error('[waitlist] join failed', cause)
    return apiError('server_error', 'We could not add you just now. Please try again in a moment.')
  }

  const task = () =>
    sendConfirmation(deps, email).catch((cause) => console.error('[waitlist] confirmation failed', cause))
  if (deps.defer) deps.defer(task)
  else await task()
  return apiOk({ ok: true })
}

async function sendConfirmation(deps: JoinDeps, email: string): Promise<void> {
  const from = inviteFromAddress()
  if (!deps.sender || !from) {
    // No mail, no way to confirm: the owner gets the list as it was before #95 rather than
    // one that hides everyone and then deletes them.
    console.error('[waitlist] confirmation email is off (SMTP or MAIL_FROM_EMAIL unset): joined unconfirmed is confirmed')
    await markConfirmed(deps.service, email)
    return
  }

  const token = newConfirmToken()
  const tokenHash = hashConfirmToken(token)
  if (!(await claimConfirmEmail(deps.service, email, tokenHash, CONFIRM_RESEND_AFTER_MS))) return

  // The cap is counted after claiming, and includes this claim: a burst of joins all see one
  // another's claims, so the count can only be over-strict, never let more through.
  const sentToday = await confirmEmailsSince(deps.service, new Date(Date.now() - CONFIRM_CAP_WINDOW_MS))
  if (sentToday > (deps.dailyCap ?? CONFIRM_EMAILS_PER_DAY)) {
    console.error('[waitlist] daily confirmation email cap reached; address kept unconfirmed')
    await releaseConfirmEmail(deps.service, email, tokenHash)
    return
  }

  try {
    await deps.sender.send(confirmMail(email, from, deps.origin, token))
  } catch (cause) {
    console.error('[waitlist] confirmation email failed', cause)
    await releaseConfirmEmail(deps.service, email, tokenHash)
  }
}

/**
 * POST /api/waitlist/confirm { token } -> { confirmed: true } or 400 `invalid_request` (field `token`).
 *
 * Reached from the button on /waitlist/confirm, never from the emailed link itself: mail
 * scanners open links, and a scanner must not confirm an address for its owner. A wrong,
 * used and expired token all get the same answer.
 */
export async function handleConfirm(db: SupabaseClient, body: unknown): Promise<Response> {
  const token = readBody(body)?.token
  const invalid = () =>
    apiError('invalid_request', 'That link has expired or was already used.', { field: 'token' })
  if (!isConfirmToken(token)) return invalid()
  try {
    const email = await confirmByToken(db, hashConfirmToken(token), CONFIRM_TTL_MS)
    return email ? apiOk({ confirmed: true }) : invalid()
  } catch (cause) {
    console.error('[waitlist] confirm failed', cause)
    return apiError('server_error', 'We could not confirm that just now. Please try again in a moment.')
  }
}

// ---------------------------------------------------------------- the account, before the link

export interface PrepareDeps {
  /** Service-role client: reads the waitlist and creates approved accounts. */
  service: SupabaseClient
  waitlistOn: boolean
}

/** What GoTrue says when the account being created is already there. */
const EXISTS_CODES = new Set(['email_exists', 'user_already_exists'])

/**
 * POST /api/auth/prepare - the only way an account is created (issue #92).
 *
 * Supabase's own sign-up is off (supabase/config.toml `[auth] enable_signup`, and the
 * dashboard toggle in production), so the browser's `signInWithOtp` only reaches existing
 * accounts. When it finds none, the login form calls this, then asks for the link again:
 *
 *  - waitlist on and the address approved, or waitlist off: create the account with the
 *    service role (confirmed: the link that follows proves the inbox);
 *  - otherwise: nothing.
 *
 * The answer is `{ ok: true }` either way, so this route cannot be used to learn who is
 * approved. The link itself is still requested by the browser, as before #92: Supabase's
 * per-IP limits see each parent's own address rather than one server's, and the PKCE
 * verifier stays in this browser for /auth/callback.
 */
export async function handlePrepareSignIn(deps: PrepareDeps, body: unknown): Promise<Response> {
  const email = normalizeEmail(readBody(body)?.email)
  if (!email) return apiError('invalid_request', BAD_EMAIL, { field: 'email' })

  const failed = () =>
    apiError('server_error', 'We could not send that link just now. Please try again in a moment.')

  try {
    if (deps.waitlistOn && !(await isApproved(deps.service, email))) return apiOk({ ok: true })
  } catch (cause) {
    console.error('[auth/prepare] waitlist lookup failed', cause)
    return failed()
  }

  const created = await deps.service.auth.admin.createUser({ email, email_confirm: true })
  if (created.error && !EXISTS_CODES.has(created.error.code ?? '')) {
    console.error('[auth/prepare] account creation failed', created.error.code, created.error.status)
    return failed()
  }
  return apiOk({ ok: true })
}

// ---------------------------------------------------------------- owner: approve

export interface ApproveDeps {
  service: SupabaseClient
  /** Null when mail is not set up: the approval still happens, and the page says no email went. */
  sender: InviteSender | null
  /** The site the invite links to - SITE_URL, or the owner's own request origin. */
  origin: string
}

/**
 * POST /api/admin/waitlist { email }. The route has already 404'd anyone but the owner.
 *
 * The invite goes at most once: the row is claimed (`invited_at` set where it was null)
 * before sending, so two presses in two tabs cannot both send, and released if the send
 * fails, so pressing Approve again retries one that never went out.
 */
export async function handleApprove(deps: ApproveDeps, body: unknown): Promise<Response> {
  const email = normalizeEmail(readBody(body)?.email)
  if (!email) return apiError('invalid_request', BAD_EMAIL, { field: 'email' })

  try {
    await approve(deps.service, email)
  } catch (cause) {
    console.error('[admin/waitlist] approve failed', cause)
    return apiError('server_error', 'Could not approve that address. Try again.')
  }

  const from = inviteFromAddress()
  if (!deps.sender || !from) return apiOk({ approved: true, emailed: false, alreadyInvited: false })

  let claimed: boolean
  try {
    claimed = await claimInvite(deps.service, email)
  } catch (cause) {
    console.error('[admin/waitlist] invite claim failed', cause)
    return apiOk({ approved: true, emailed: false, alreadyInvited: false })
  }
  if (!claimed) return apiOk({ approved: true, emailed: false, alreadyInvited: true })

  try {
    await deps.sender.send(inviteMail(email, from, deps.origin))
  } catch (cause) {
    console.error('[admin/waitlist] invite email failed', cause)
    await releaseInvite(deps.service, email).catch((e) => console.error('[admin/waitlist] release failed', e))
    return apiOk({ approved: true, emailed: false, alreadyInvited: false })
  }
  return apiOk({ approved: true, emailed: true, alreadyInvited: false })
}
