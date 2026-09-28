import { NextResponse, type NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'
import { ensureFamily } from '@/lib/family/service'
import { isValidTimeZone } from '@/lib/family/timezone'

/**
 * F2: the magic-link / OAuth landing route.
 *
 * Supabase sends the parent to `/auth/callback` with either a PKCE `code` (what
 * `signInWithOtp` and `signInWithOAuth` from the browser client produce) or a
 * `token_hash` + `type` pair (what a custom email template produces). Both are handled so
 * the flow does not break if the email template is ever changed.
 *
 * On success the family row is created if it does not exist. That is the ONLY place a
 * family is created during login, and `ensureFamily` is idempotent, so opening the link
 * twice cannot produce a second family (F2 AC).
 */

/** Never redirect to an absolute URL from a query parameter - that is an open redirect. */
function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard'
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
  return raw
}

function loginWithError(request: NextRequest, message: string): NextResponse {
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  url.searchParams.set('error', message)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const next = safeNext(params.get('next'))
  const code = params.get('code')
  const tokenHash = params.get('token_hash')
  const type = params.get('type')

  if (params.get('error') || params.get('error_description')) {
    return loginWithError(request, 'That sign-in link did not work. Please request a new one.')
  }
  if (!code && !tokenHash) {
    return loginWithError(request, 'That sign-in link is missing its token. Please try again.')
  }

  const db = await supabaseServer()

  if (code) {
    const { error } = await db.auth.exchangeCodeForSession(code)
    if (error) {
      return loginWithError(request, 'That sign-in link has expired. Please request a new one.')
    }
  } else if (tokenHash) {
    const { error } = await db.auth.verifyOtp({
      type: (type as 'magiclink' | 'email' | 'signup' | 'recovery' | null) ?? 'magiclink',
      token_hash: tokenHash,
    })
    if (error) {
      return loginWithError(request, 'That sign-in link has expired. Please request a new one.')
    }
  }

  const {
    data: { user },
  } = await db.auth.getUser()
  if (!user) {
    return loginWithError(request, 'We could not complete the sign-in. Please try again.')
  }

  // The login page records the browser's timezone in a short-lived cookie so a brand new
  // family starts with the right quota day boundary (F8) instead of UTC.
  const detected = request.cookies.get('st_tz')?.value
  const timezone = isValidTimeZone(detected) ? detected : null

  try {
    await ensureFamily(db, user.id, { timezone })
  } catch (cause) {
    console.error('[auth/callback] ensureFamily failed', cause)
    return loginWithError(request, 'We signed you in but could not set up your family account.')
  }

  // `next` is a validated relative path, so resolving it against our own origin cannot
  // leave it. Using URL rather than assigning `pathname` keeps any query string intact.
  const destination = new URL(next, request.nextUrl.origin)
  const response = NextResponse.redirect(destination)
  response.cookies.delete('st_tz')
  return response
}
