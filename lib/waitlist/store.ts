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

/** Waiting first (oldest first, the fair order), then the approved, newest first. */
export async function listWaitlist(db: SupabaseClient): Promise<WaitlistRow[]> {
  const { data, error } = await db
    .from('waitlist')
    .select('email, created_at, approved_at, invited_at')
    .order('created_at', { ascending: true })
    .limit(2000)
  if (error) throw new Error(`waitlist list failed: ${error.message}`)
  const rows = (data ?? []) as WaitlistRow[]
  const waiting = rows.filter((r) => !r.approved_at)
  const approved = rows
    .filter((r) => r.approved_at)
    .sort((a, b) => (b.approved_at ?? '').localeCompare(a.approved_at ?? ''))
  return [...waiting, ...approved]
}

/**
 * Approve an address, adding it first if it never joined (the owner may approve someone
 * directly). Approving again keeps the first approval time. Returns whether the invite email
 * has already gone, so a second press resends only one that never went out.
 */
export async function approve(db: SupabaseClient, email: string): Promise<{ invited: boolean }> {
  await joinWaitlist(db, email)
  const { error } = await db
    .from('waitlist')
    .update({ approved_at: new Date().toISOString() })
    .eq('email', email)
    .is('approved_at', null)
  if (error) throw new Error(`waitlist approve failed: ${error.message}`)
  const { data, error: readError } = await db
    .from('waitlist')
    .select('invited_at')
    .eq('email', email)
    .single()
  if (readError) throw new Error(`waitlist approve read failed: ${readError.message}`)
  return { invited: Boolean(data.invited_at) }
}

export async function markInvited(db: SupabaseClient, email: string): Promise<void> {
  const { error } = await db
    .from('waitlist')
    .update({ invited_at: new Date().toISOString() })
    .eq('email', email)
  if (error) throw new Error(`waitlist invite mark failed: ${error.message}`)
}
