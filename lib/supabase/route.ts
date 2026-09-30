import { createServerClient, type CookieOptions } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { serverEnv } from '@/lib/env'

/**
 * A Supabase client for a route handler that has to CHANGE the session - sign in, sign out,
 * delete the account.
 *
 * `supabaseServer()` writes cookies through `next/headers`, which is right when Next owns
 * the response. A handler that returns its own `Response` (a redirect, or a JSON body) has
 * to put the new cookies on that object itself, or the session change is computed and then
 * discarded: the parent verifies a magic link and bounces straight back to /login, or signs
 * out and stays signed in. That bug is invisible in unit tests and obvious in Playwright,
 * which is how it was found.
 *
 * Read-only handlers should keep using `supabaseServer()`; this is only for the three
 * places that mutate the session.
 */
export interface RouteSupabase {
  db: SupabaseClient
  /**
   * Re-issue `response` with any cookies Supabase asked for attached. Serialization is
   * left to `NextResponse.cookies`, which already gets the details right.
   */
  commit: (response: Response) => NextResponse
}

type PendingCookie = { name: string; value: string; options: CookieOptions }

export function supabaseRoute(request: Request): RouteSupabase {
  const pending: PendingCookie[] = []
  const env = serverEnv()

  const db = createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => parseCookieHeader(request.headers.get('cookie') ?? ''),
      setAll: (toSet) => {
        for (const cookie of toSet) pending.push(cookie as PendingCookie)
      },
    },
  })

  const commit = (response: Response): NextResponse => {
    const next =
      response instanceof NextResponse ? response : new NextResponse(response.body, response)
    for (const { name, value, options } of pending) next.cookies.set(name, value, options)
    return next
  }

  return { db, commit }
}

/** Minimal `Cookie:` header parser - name and value is all @supabase/ssr reads. */
function parseCookieHeader(header: string): { name: string; value: string }[] {
  if (header === '') return []
  const out: { name: string; value: string }[] = []
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    const name = part.slice(0, index).trim()
    if (name === '') continue
    out.push({ name, value: decodeURIComponent(part.slice(index + 1).trim()) })
  }
  return out
}
