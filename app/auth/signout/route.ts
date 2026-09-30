import { redirectTo } from '@/lib/http/responses'
import { supabaseRoute } from '@/lib/supabase/route'

/**
 * POST-only sign out (F2). A GET would let any page log the parent out with an
 * `<img src>`, which is a CSRF, not a feature.
 *
 * 303 so the browser follows it with a GET rather than re-POSTing.
 */
export async function POST(request: Request) {
  const { db, commit } = supabaseRoute(request)
  await db.auth.signOut()
  return commit(redirectTo('/', { status: 303 }))
}
