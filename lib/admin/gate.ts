import { notFound } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * F12 AC: a non-owner gets **404, not 403** — the page must not reveal that it exists.
 * That means no "forbidden" copy, no redirect to a login wall that hints at an admin area,
 * and no difference in behaviour between "signed out", "signed in as a parent" and
 * "OWNER_USER_ID is unset".
 */

// The owner check itself lives in lib/owner.ts (shared with the quota exemption); this
// module keeps the 404 behaviour. Unset OWNER_USER_ID fails closed: /admin 404s for everyone.
import { isOwner } from '@/lib/owner'
export { isOwner, ownerUserId } from '@/lib/owner'

/** Never returns for a non-owner: `notFound()` throws Next's 404. */
export function assertOwner(userId: string | null | undefined): void {
  if (!isOwner(userId)) notFound()
}

/**
 * Resolve the signed-in user and 404 unless they are the owner.
 * Returns the owner's user id on success.
 */
export async function requireOwner(): Promise<string> {
  let userId: string | null = null
  try {
    const supabase = await supabaseServer()
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
  } catch {
    // No session, no cookies, auth unreachable — all indistinguishable from "not the owner".
    userId = null
  }
  assertOwner(userId)
  return userId as string
}
