/**
 * One spelling per inbox (issue #92): the waitlist's primary key, the approval check and the
 * account all use the same lowercased, trimmed address, so "Ana@Example.com " approved is
 * "ana@example.com" signing in.
 */

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** RFC 5321's limit on a whole address. */
export const MAX_EMAIL_LENGTH = 254

/** The normalised address, or null when it is not one we could send a link to. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return null
  return EMAIL_SHAPE.test(email) ? email : null
}
