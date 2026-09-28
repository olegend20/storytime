import type { SupabaseClient, User } from '@supabase/supabase-js'
import { supabaseServer } from '@/lib/supabase/server'
import { ensureFamily, getFamily, type FamilyRow } from '@/lib/family/service'

/**
 * Request-scoped auth context for Server Components and route handlers (F2).
 *
 * `getUser()` is used rather than `getSession()` throughout: it validates the JWT with the
 * auth server, where `getSession()` trusts whatever is in the cookie.
 */

export interface AuthContext {
  db: SupabaseClient
  user: User
}

export async function currentUser(): Promise<AuthContext | null> {
  const db = await supabaseServer()
  const {
    data: { user },
    error,
  } = await db.auth.getUser()
  if (error || !user) return null
  return { db, user }
}

export interface FamilyContext extends AuthContext {
  family: FamilyRow
}

/**
 * The caller's family, created on the spot if this is their first request.
 *
 * `/auth/callback` already creates it at login; this is the safety net for a session that
 * predates the family row (or a user created straight through the admin API in a test).
 */
export async function currentFamily(): Promise<FamilyContext | null> {
  const auth = await currentUser()
  if (!auth) return null
  const family = await ensureFamily(auth.db, auth.user.id)
  return { ...auth, family }
}

/** Like `currentFamily`, but never creates a row. */
export async function currentFamilyIfAny(): Promise<FamilyContext | null> {
  const auth = await currentUser()
  if (!auth) return null
  const family = await getFamily(auth.db, auth.user.id)
  if (!family) return null
  return { ...auth, family }
}
