import { deleteAccount } from '@/lib/family/service'
import { supabaseRoute } from '@/lib/supabase/route'
import { supabaseService } from '@/lib/supabase/service'
import { apiError, apiOk } from '@/lib/http/responses'

/**
 * F2 - account deletion. DELETE /api/account
 *
 * The family row is deleted through the caller's own RLS-scoped client, in one statement,
 * so the cascade to children / series / story_bibles / stories / daily_usage is one
 * transaction (F2 AC). `generation_logs.family_id` is `on delete set null`, so the cost
 * history survives, anonymized, without a second write.
 *
 * The service-role client is used for exactly two things afterwards: counting the
 * anonymized log rows (a client cannot see that table at all) and removing the
 * `auth.users` row so "delete my account" is true rather than nearly true.
 *
 * `supabaseRoute` rather than `supabaseServer` because the sign-out at the end has to clear
 * the session cookies on this response.
 */
export async function DELETE(request: Request) {
  const { db, commit } = supabaseRoute(request)
  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) return apiError('unauthorized', 'Please sign in.')

  let serviceDb
  try {
    serviceDb = supabaseService()
  } catch (cause) {
    console.error('[api/account] service role client unavailable', cause)
    return apiError('server_error', 'We could not delete the account. Please try again.')
  }

  const result = await deleteAccount(db, user.id, { serviceDb })
  if (!result) {
    // No family row. The auth user still has to go.
    await serviceDb.auth.admin.deleteUser(user.id)
    await db.auth.signOut()
    return commit(apiOk({ deleted: true, removed: null }))
  }

  await db.auth.signOut()
  return commit(apiOk({ deleted: true, removed: result.removed }))
}
