import { notFound } from 'next/navigation'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * F12 AC: a non-owner gets **404, not 403** — the page must not reveal that it exists.
 * That means no "forbidden" copy, no redirect to a login wall that hints at an admin area,
 * and no difference in behaviour between "signed out", "signed in as a parent" and
 * "OWNER_USER_ID is unset".
 */

/** Read fresh from the environment so rotating the owner takes effect without a rebuild. */
export function ownerUserId(): string | null {
  const raw = process.env.OWNER_USER_ID?.trim()
  return raw && raw.length > 0 ? raw : null
}

export function isOwner(userId: string | null | undefined): boolean {
  const owner = ownerUserId()
  // Unset OWNER_USER_ID means nobody is the owner. Fails closed: /admin 404s for everyone.
  if (!owner) return false
  return typeof userId === 'string' && userId === owner
}

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
