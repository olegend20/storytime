import type { NextRequest } from 'next/server'
import { apiError, readJsonBody } from '@/lib/http/responses'
import { supabaseRoute } from '@/lib/supabase/route'
import { supabaseService } from '@/lib/supabase/service'
import { handleSignInEmail } from '@/lib/waitlist/handlers'
import { waitlistEnabled } from '@/lib/waitlist/mode'

/**
 * Issue #92 - email a sign-in link, creating the account only for an address that may have
 * one. This replaced the browser's direct `signInWithOtp`, which created an account for any
 * address at all.
 *
 * POST /api/auth/email { email, next? } -> { status: 'sent' | 'not_approved' }
 *
 * The link is requested through `supabaseRoute`, so the PKCE verifier lands in this
 * browser's cookies and `/auth/callback` can exchange the code exactly as before.
 */

function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return ''
  return raw
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')

  const callback = new URL('/auth/callback', request.nextUrl.origin)
  const next = safeNext((body as { next?: unknown } | null)?.next)
  if (next) callback.searchParams.set('next', next)

  const { db, commit } = supabaseRoute(request)
  const response = await handleSignInEmail(
    {
      sendLink: async (email) => {
        const { error } = await db.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false, emailRedirectTo: callback.toString() },
        })
        return { error: error ? { code: error.code, status: error.status, message: error.message } : null }
      },
      service: supabaseService(),
      waitlistOn: waitlistEnabled(),
    },
    body,
  )
  return commit(response)
}
