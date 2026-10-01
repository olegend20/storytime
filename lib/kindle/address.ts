/**
 * A Send-to-Kindle address: `something@kindle.com` (or the legacy `@free.kindle.com`).
 * Parent data, not child data (rule 7 untouched). Anything that is not exactly that
 * shape is refused - there is no reason for HTML, spaces or another domain here.
 */
export const KINDLE_ADDRESS = /^[a-z0-9][a-z0-9._-]{0,62}@(?:free\.)?kindle\.com$/i

export function normalizeKindleAddress(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isKindleAddress(raw: string): boolean {
  return KINDLE_ADDRESS.test(normalizeKindleAddress(raw))
}
