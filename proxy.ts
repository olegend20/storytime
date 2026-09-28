import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { clientIp, rateLimitHeaders, checkRateLimit, RATE_LIMITED_BODY } from '@/lib/http/ratelimit'

/**
 * Three jobs, in this order:
 *
 *  1. F11 - IP rate limit on every `/api/*` request (30/min, then 429). Doing it here
 *     rather than per route means a route added by another lane is covered the day it
 *     lands, and an unauthenticated flood is turned away before it touches the database.
 *  2. Refresh the Supabase session cookie so Server Components see a live session.
 *  3. F2 AC - "Unauthenticated users can only see the landing page and login."
 *     Protected pages redirect to /login; protected API routes get a 401 JSON body.
 *
 * Reads the NEXT_PUBLIC_ mirrors rather than `lib/env.ts`: this must not pull the
 * server secret schema into the edge bundle.
 */

/** Page prefixes that require a session. `/stories` is lane 4's reader (F11 VT). */
const PROTECTED_PAGES = ['/dashboard', '/children', '/settings', '/stories', '/new', '/admin']

/** API prefixes that require a session. `/api/health` and friends stay public. */
const PROTECTED_API = ['/api/children', '/api/family', '/api/account', '/api/stories', '/api/quota']

function isUnder(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ---------------------------------------------------------------- 1. rate limit
  if (pathname.startsWith('/api/')) {
    const verdict = checkRateLimit(clientIp(request.headers))
    if (!verdict.allowed) {
      return NextResponse.json(RATE_LIMITED_BODY, {
        status: 429,
        headers: rateLimitHeaders(verdict),
      })
    }
  }

  let response = NextResponse.next({ request })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    // Misconfigured deployment. Fail closed on anything that needs a session rather than
    // letting a request through unauthenticated.
    if (isUnder(pathname, PROTECTED_API)) {
      return NextResponse.json(
        { code: 'server_error', message: 'The server is not configured correctly.', field: null },
        { status: 500 },
      )
    }
    return response
  }

  // ---------------------------------------------------------------- 2. refresh session
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options)
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // ---------------------------------------------------------------- 3. route guards
  if (!user) {
    if (isUnder(pathname, PROTECTED_API)) {
      return NextResponse.json(
        { code: 'unauthorized', message: 'Please sign in.', field: null },
        { status: 401, headers: response.headers },
      )
    }
    if (isUnder(pathname, PROTECTED_PAGES)) {
      const login = request.nextUrl.clone()
      login.pathname = '/login'
      login.search = ''
      // Where to land after signing in. Relative path only - never an absolute URL.
      login.searchParams.set('next', `${pathname}${request.nextUrl.search}`)
      return NextResponse.redirect(login)
    }
    return response
  }

  // Signed in: the login page has nothing to offer.
  if (pathname === '/login') {
    const dashboard = request.nextUrl.clone()
    dashboard.pathname = '/dashboard'
    dashboard.search = ''
    return NextResponse.redirect(dashboard)
  }

  return response
}

export const config = {
  /**
   * Everything except Next's own assets and static files. The negative lookahead keeps
   * the session refresh off image and font requests, which would otherwise triple the
   * auth traffic for one page view.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
