import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The `waitlist` table (issue #92). Service role only - every caller passes
 * `supabaseService()`; the anon and authenticated roles have no grant on it.
 */

export interface WaitlistRow {
  email: string
  created_at: string
  approved_at: string | null
  invited_at: string | null
  confirmed_at: string | null
}

/** Add an address. Joining twice is a no-op, so the caller cannot tell who was already there. */
export async function joinWaitlist(db: SupabaseClient, email: string): Promise<void> {
  const { error } = await db
    .from('waitlist')
    .upsert({ email }, { onConflict: 'email', ignoreDuplicates: true })
  if (error) throw new Error(`waitlist join failed: ${error.message}`)
}

export async function isApproved(db: SupabaseClient, email: string): Promise<boolean> {
  const { data, error } = await db
    .from('waitlist')
    .select('approved_at')
    .eq('email', email)
    .maybeSingle()
  if (error) throw new Error(`waitlist lookup failed: ${error.message}`)
  return Boolean(data?.approved_at)
}

/** How many rows each list on the owner page shows; the counts are always exact. */
export const WAITLIST_PAGE = 500

export interface WaitlistView {
  waiting: WaitlistRow[]
  approved: WaitlistRow[]
  waitingCount: number
  approvedCount: number
  /** Joined but never confirmed their address (issue #95): not shown, only counted. */
  unconfirmedCount: number
}

/**
 * The owner page: the confirmed people waiting longest first (the fair order), and the most
 * recently approved. Separate queries, so a long list on one side never pushes the other off
 * the page. Unconfirmed addresses (issue #95) are only counted.
 */
export async function listWaitlist(db: SupabaseClient): Promise<WaitlistView> {
  const cols = 'email, created_at, approved_at, invited_at, confirmed_at'
  const [waiting, approved, unconfirmed] = await Promise.all([
    db.from('waitlist').select(cols, { count: 'exact' }).is('approved_at', null)
      .not('confirmed_at', 'is', null)
      .order('created_at', { ascending: true }).limit(WAITLIST_PAGE),
    db.from('waitlist').select(cols, { count: 'exact' }).not('approved_at', 'is', null)
      .order('approved_at', { ascending: false }).limit(WAITLIST_PAGE),
    db.from('waitlist').select('email', { count: 'exact', head: true }).is('approved_at', null)
      .is('confirmed_at', null),
  ])
  const error = waiting.error ?? approved.error ?? unconfirmed.error
  if (error) throw new Error(`waitlist list failed: ${error.message}`)
  return {
    waiting: (waiting.data ?? []) as WaitlistRow[],
    approved: (approved.data ?? []) as WaitlistRow[],
    waitingCount: waiting.count ?? 0,
    approvedCount: approved.count ?? 0,
    unconfirmedCount: unconfirmed.count ?? 0,
  }
}

/**
 * Approve an address, adding it first if it never joined (the owner may approve someone
 * directly). Approving again keeps the first approval time. The owner's approval vouches for
 * the address, so it also counts as confirmed (issue #95), and its pending link stops working.
 */
export async function approve(db: SupabaseClient, email: string): Promise<void> {
  await joinWaitlist(db, email)
  // Confirmed first: if the approval then fails, the row is merely confirmed, and pressing
  // Approve again finishes the job - never approved with a live link.
  await markConfirmed(db, email)
  const { error } = await db
    .from('waitlist')
    .update({ approved_at: new Date().toISOString() })
    .eq('email', email)
    .is('approved_at', null)
  if (error) throw new Error(`waitlist approve failed: ${error.message}`)
}

/** Confirm an address without a token (the owner vouched, or there is no mail to confirm by). */
export async function markConfirmed(db: SupabaseClient, email: string): Promise<void> {
  const { error } = await db
    .from('waitlist')
    .update({ confirmed_at: new Date().toISOString(), confirm_token_hash: null })
    .eq('email', email)
    .is('confirmed_at', null)
  if (error) throw new Error(`waitlist confirm failed: ${error.message}`)
}

/** Take the right to send this address its invite: true for exactly one caller. */
export async function claimInvite(db: SupabaseClient, email: string): Promise<boolean> {
  const { data, error } = await db
    .from('waitlist')
    .update({ invited_at: new Date().toISOString() })
    .eq('email', email)
    .not('approved_at', 'is', null)
    .is('invited_at', null)
    .select('email')
  if (error) throw new Error(`waitlist invite claim failed: ${error.message}`)
  return (data ?? []).length > 0
}

/** The send failed: give the claim back, so the next press tries again. */
export async function releaseInvite(db: SupabaseClient, email: string): Promise<void> {
  const { error } = await db.from('waitlist').update({ invited_at: null }).eq('email', email)
  if (error) throw new Error(`waitlist invite release failed: ${error.message}`)
}

// ---------------------------------------------------------------- confirmation (issue #95)

/** A timestamp as a PostgREST `or=` filter value: quoted, because it holds ':' and '.'. */
const quoted = (d: Date) => `"${d.toISOString()}"`

/**
 * Take the right to email this address a confirmation link, storing the new token's hash:
 * true for exactly one caller, and only when the address is unconfirmed and had no email in
 * the last `resendAfterMs`. Storing a new hash retires any older link.
 */
export async function claimConfirmEmail(
  db: SupabaseClient,
  email: string,
  tokenHash: string,
  resendAfterMs: number,
  now = new Date(),
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - resendAfterMs)
  const { data, error } = await db
    .from('waitlist')
    .update({ confirm_token_hash: tokenHash, confirm_sent_at: now.toISOString() })
    .eq('email', email)
    .is('confirmed_at', null)
    .or(`confirm_sent_at.is.null,confirm_sent_at.lt.${quoted(cutoff)}`)
    .select('email')
  if (error) throw new Error(`waitlist confirm claim failed: ${error.message}`)
  return (data ?? []).length > 0
}

/** How many confirmation emails went out since `since`: the daily cap's count. */
export async function confirmEmailsSince(db: SupabaseClient, since: Date): Promise<number> {
  const { count, error } = await db
    .from('waitlist')
    .select('email', { count: 'exact', head: true })
    .gt('confirm_sent_at', since.toISOString())
  if (error) throw new Error(`waitlist confirm count failed: ${error.message}`)
  return count ?? 0
}

/** The send failed: give the claim back, so joining again tries again. Only this claim's. */
export async function releaseConfirmEmail(db: SupabaseClient, email: string, tokenHash: string): Promise<void> {
  const { error } = await db
    .from('waitlist')
    .update({ confirm_token_hash: null, confirm_sent_at: null })
    .eq('email', email)
    .eq('confirm_token_hash', tokenHash)
  if (error) throw new Error(`waitlist confirm release failed: ${error.message}`)
}

/**
 * Use a confirmation token: the address it was sent to, once, within `ttlMs` of sending; null
 * for a wrong, used or expired token. One conditional update, so two clicks confirm once.
 */
export async function confirmByToken(
  db: SupabaseClient,
  tokenHash: string,
  ttlMs: number,
  now = new Date(),
): Promise<string | null> {
  const { data, error } = await db
    .from('waitlist')
    .update({ confirmed_at: now.toISOString(), confirm_token_hash: null })
    .eq('confirm_token_hash', tokenHash)
    .is('confirmed_at', null)
    .gt('confirm_sent_at', new Date(now.getTime() - ttlMs).toISOString())
    .select('email')
  if (error) throw new Error(`waitlist confirm failed: ${error.message}`)
  return (data?.[0]?.email as string | undefined) ?? null
}

/**
 * Forget addresses nobody confirmed: unconfirmed and unapproved, and either emailed more than
 * `ttlMs` ago (the link expired unused) or never emailed and older than `unsentTtlMs`.
 */
export async function purgeUnconfirmed(
  db: SupabaseClient,
  ttlMs: number,
  unsentTtlMs: number,
  now = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - ttlMs)
  const unsentCutoff = new Date(now.getTime() - unsentTtlMs)
  const { error } = await db
    .from('waitlist')
    .delete()
    .is('confirmed_at', null)
    .is('approved_at', null)
    .lt('created_at', cutoff.toISOString())
    .or(
      `confirm_sent_at.lt.${quoted(cutoff)},` +
        `and(confirm_sent_at.is.null,created_at.lt.${quoted(unsentCutoff)})`,
    )
  if (error) throw new Error(`waitlist purge failed: ${error.message}`)
}
