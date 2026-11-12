import type { NextRequest } from 'next/server'
import { serverEnv } from '@/lib/env'
import { redirectTo } from '@/lib/http/responses'

/**
 * The link in the sign-in email (issue #101): on lastten.org, so a parent sees our address,
 * not Supabase's. It hands straight on to Supabase's own check (`/auth/v1/verify`), which
 * returns to /auth/callback with a PKCE `code`. That code only works in the browser that asked
 * for the link - the owner's choice (DECISIONS #219): a forwarded email, or a mail scanner
 * that opens links, cannot sign anyone in.
 *
 * Only the two sign-in types are passed on; anything else goes back to the login page.
 */

const SIGN_IN_TYPES = new Set(['magiclink', 'signup'])

export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const tokenHash = params.get('token_hash')
  const type = params.get('type')
  if (!tokenHash || !/^[\w-]{10,200}$/.test(tokenHash) || !type || !SIGN_IN_TYPES.has(type)) {
    return redirectTo(`/login?error=${encodeURIComponent('That sign-in link is missing its token. Please try again.')}`)
  }

  // Back to the very origin this link was opened on: the PKCE verifier cookie lives there.
  // `request.nextUrl.origin` would say localhost for 127.0.0.1 (see lib/http/responses.ts), a
  // different cookie jar; Host is what the browser used (lastten.org in production).
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '')
  const site = `${proto}://${host}`
  const verify = new URL('/auth/v1/verify', serverEnv().SUPABASE_URL)
  verify.searchParams.set('token', tokenHash)
  verify.searchParams.set('type', type)
  verify.searchParams.set('redirect_to', new URL('/auth/callback', site).toString())
  return new Response(null, { status: 302, headers: { location: verify.toString(), 'cache-control': 'no-store' } })
}
