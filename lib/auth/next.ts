/**
 * Where a parent goes after signing in (issue #101).
 *
 * The sign-in email's link is built by its template (/auth/link), which cannot carry the page
 * the parent started from. So the login form leaves it in a short-lived cookie, and the
 * callback takes, in order: `?next=` (Google sign-in still carries it), the cookie, then the
 * dashboard.
 */
export const NEXT_COOKIE = 'st_next'
/**
 * As long as a sign-in link lasts: Supabase's OTP expiry, an hour by default (`otp_expiry`,
 * not set in supabase/config.toml or production). Raise both together.
 */
export const NEXT_COOKIE_MAX_AGE_S = 60 * 60
export const DEFAULT_NEXT = '/dashboard'

/**
 * Only a path on this site. Never an absolute URL, `//host` or `/\host` (browsers treat a
 * backslash as a slash), or anything with a control character: each is an open redirect.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_NEXT
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return DEFAULT_NEXT
  if (/[\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_NEXT
  return raw
}

export function resolveNext(query: string | null | undefined, cookie: string | null | undefined): string {
  if (query) return safeNext(query)
  // Next has already decoded the cookie's value (`request.cookies`); decoding again would
  // corrupt a path holding a literal `%`.
  return safeNext(cookie)
}
