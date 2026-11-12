/**
 * Where a parent goes after signing in (issue #101).
 *
 * The sign-in email links straight to /auth/callback on our own site, built by the email
 * template, which cannot carry the page the parent started from. So the login form leaves it
 * in a short-lived cookie, and the callback takes, in order: `?next=` on the link (Google
 * sign-in and older emails still carry it), the cookie, then the dashboard. On another device
 * there is no cookie, and the dashboard is the right place anyway.
 */
export const NEXT_COOKIE = 'st_next'
/** As long as a sign-in link lasts (Supabase's default OTP expiry is an hour). */
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

/** The cookie as the browser wrote it (URI-encoded); undecodable means unusable. */
function decodeCookie(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

export function resolveNext(query: string | null | undefined, cookie: string | null | undefined): string {
  if (query) return safeNext(query)
  return safeNext(decodeCookie(cookie))
}
