import { currentUser } from '@/lib/auth/session'
import { deleteAccount } from '@/lib/family/service'
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
 */
export async function DELETE() {
  const ctx = await currentUser()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')

  let serviceDb
  try {
    serviceDb = supabaseService()
  } catch (cause) {
    console.error('[api/account] service role client unavailable', cause)
    return apiError('server_error', 'We could not delete the account. Please try again.')
  }

  const result = await deleteAccount(ctx.db, ctx.user.id, { serviceDb })
  if (!result) {
    // No family row. The auth user still has to go.
    await serviceDb.auth.admin.deleteUser(ctx.user.id)
    await ctx.db.auth.signOut()
    return apiOk({ deleted: true, removed: null })
  }

  await ctx.db.auth.signOut()
  return apiOk({ deleted: true, removed: result.removed })
}
