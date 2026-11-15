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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Issue #110: extra accounts that may open /admin, besides the owner. `ADMIN_USER_IDS` is a
 * comma-separated list of auth user ids. It grants the admin pages and nothing else: the
 * unlimited daily quota stays with `OWNER_USER_ID` alone (DECISIONS #141, lib/owner.ts).
 *
 * Read fresh on every call, like the owner, so adding an admin needs no rebuild. Spaces and
 * empty entries are ignored, and an entry that is not a uuid matches nobody.
 */
export function adminUserIds(): string[] {
  const raw = process.env.ADMIN_USER_IDS ?? ''
  return raw
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => UUID.test(id))
}

/** The owner, or a listed admin. Fails closed: with both unset, nobody is an admin. */
export function isAdmin(userId: string | null | undefined): boolean {
  if (typeof userId !== 'string' || userId.length === 0) return false
  return isOwner(userId) || adminUserIds().includes(userId.toLowerCase())
}

/** Never returns for a non-admin: `notFound()` throws Next's 404. */
export function assertOwner(userId: string | null | undefined): void {
  if (!isAdmin(userId)) notFound()
}

/** The signed-in user's id, or null - no session, no cookies and auth unreachable alike. */
async function currentUserId(): Promise<string | null> {
  try {
    const supabase = await supabaseServer()
    const { data } = await supabase.auth.getUser()
    return data.user?.id ?? null
  } catch {
    return null
  }
}

/** For a route handler that answers a non-admin with its own 404 (issues #92, #110). */
export async function currentUserIsOwner(): Promise<boolean> {
  return isAdmin(await currentUserId())
}

/**
 * Resolve the signed-in user and 404 unless they are the owner or a listed admin (#110).
 * Returns that user's id on success.
 */
export async function requireOwner(): Promise<string> {
  const userId = await currentUserId()
  assertOwner(userId)
  return userId as string
}
