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
}

/**
 * The owner page: the people waiting longest first (the fair order), and the most recently
 * approved. Two queries, so a long list on one side never pushes the other off the page.
 */
export async function listWaitlist(db: SupabaseClient): Promise<WaitlistView> {
  const cols = 'email, created_at, approved_at, invited_at'
  const [waiting, approved] = await Promise.all([
    db.from('waitlist').select(cols, { count: 'exact' }).is('approved_at', null)
      .order('created_at', { ascending: true }).limit(WAITLIST_PAGE),
    db.from('waitlist').select(cols, { count: 'exact' }).not('approved_at', 'is', null)
      .order('approved_at', { ascending: false }).limit(WAITLIST_PAGE),
  ])
  const error = waiting.error ?? approved.error
  if (error) throw new Error(`waitlist list failed: ${error.message}`)
  return {
    waiting: (waiting.data ?? []) as WaitlistRow[],
    approved: (approved.data ?? []) as WaitlistRow[],
    waitingCount: waiting.count ?? 0,
    approvedCount: approved.count ?? 0,
  }
}

/**
 * Approve an address, adding it first if it never joined (the owner may approve someone
 * directly). Approving again keeps the first approval time.
 */
export async function approve(db: SupabaseClient, email: string): Promise<void> {
  await joinWaitlist(db, email)
  const { error } = await db
    .from('waitlist')
    .update({ approved_at: new Date().toISOString() })
    .eq('email', email)
    .is('approved_at', null)
  if (error) throw new Error(`waitlist approve failed: ${error.message}`)
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
