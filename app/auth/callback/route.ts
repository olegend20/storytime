import type { NextRequest } from 'next/server'
import { NEXT_COOKIE, resolveNext } from '@/lib/auth/next'
import { ensureFamily } from '@/lib/family/service'
import { isValidTimeZone } from '@/lib/family/timezone'
import { redirectTo } from '@/lib/http/responses'
import { supabaseRoute } from '@/lib/supabase/route'

/**
 * F2: the magic-link / OAuth landing route.
 *
 * The sign-in email links here directly with a `token_hash` + `type` pair (issue #101: the
 * template builds the link on our own site, and it works on any device because it needs no
 * PKCE verifier). Google sign-in, and sign-in emails sent before #101, arrive with a PKCE
 * `code` instead. Both are handled.
 *
 * On success the family row is created if it does not exist. This is the only place login
 * creates a family, and `ensureFamily` is idempotent, so opening the link twice cannot
 * produce a second one (F2 AC).
 *
 * Every redirect here is relative, and the Supabase client comes from `supabaseRoute` -
 * see the notes on `redirectTo` and `supabaseRoute` for why either one alone is not enough
 * to keep the new session.
 */

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const next = resolveNext(params.get('next'), request.cookies.get(NEXT_COOKIE)?.value)
  const code = params.get('code')
  const tokenHash = params.get('token_hash')
  const type = params.get('type')

  const { db, commit } = supabaseRoute(request)

  const failWith = (message: string) => {
    const response = commit(redirectTo(`/login?error=${encodeURIComponent(message)}`))
    response.cookies.delete(NEXT_COOKIE)
    return response
  }

  if (params.get('error') || params.get('error_description')) {
    return failWith('That sign-in link did not work. Please request a new one.')
  }
  if (!code && !tokenHash) {
    return failWith('That sign-in link is missing its token. Please try again.')
  }

  if (code) {
    const { error } = await db.auth.exchangeCodeForSession(code)
    if (error) return failWith('That sign-in link has expired. Please request a new one.')
  } else if (tokenHash) {
    const { error } = await db.auth.verifyOtp({
      type: (type as 'magiclink' | 'email' | 'signup' | 'recovery' | null) ?? 'email',
      token_hash: tokenHash,
    })
    if (error) return failWith('That sign-in link has expired. Please request a new one.')
  }

  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) return failWith('We could not complete the sign-in. Please try again.')

  // The login page records the browser's timezone in a short-lived cookie, so a brand new
  // family starts with the right quota day boundary (F8) instead of UTC.
  const detected = request.cookies.get('st_tz')?.value
  const timezone = isValidTimeZone(detected) ? detected : null

  try {
    await ensureFamily(db, user.id, { timezone })
  } catch (cause) {
    console.error('[auth/callback] ensureFamily failed', cause)
    return failWith('We signed you in but could not set up your family account.')
  }

  const response = commit(redirectTo(next))
  response.cookies.delete('st_tz')
  response.cookies.delete(NEXT_COOKIE)
  return response
}
