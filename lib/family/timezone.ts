/**
 * Timezone handling for the family account (F2).
 *
 * F8 draws the daily-quota day boundary at local midnight in the family's timezone, so
 * this must be a real IANA zone name that Postgres and `Intl` both understand - not an
 * abbreviation ("EST") and not a fixed offset ("+05:00"), either of which would drift
 * across a DST change and move the reset time under the family's feet.
 */

export const DEFAULT_TIMEZONE = 'UTC'

/**
 * IANA zone names look like `Area/Location`, optionally `Area/Region/Location`.
 * `Etc/GMT+5` justifies the `+`; `America/Argentina/Buenos_Aires` the third segment.
 */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+.-]+){1,2}$/

/**
 * True for a zone name this runtime can resolve. The shape test comes first because
 * `Intl.DateTimeFormat` also accepts abbreviations like `EST` and `GMT`, which are not
 * zones and do not track DST.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const tz = value.trim()
  if (tz === '') return false
  if (tz === 'UTC') return true
  if (!IANA_SHAPE.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)
    return true
  } catch {
    return false
  }
}

/** Normalize a candidate zone, falling back to UTC rather than storing something unusable. */
export function normalizeTimeZone(value: unknown): string {
  if (!isValidTimeZone(value)) return DEFAULT_TIMEZONE
  return value.trim()
}

/**
 * The zones offered in the settings picker. `Intl.supportedValuesOf` is available on
 * Node 20+ and every browser we target; the fallback keeps the page usable if it is not.
 */
export function supportedTimeZones(): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf
  if (typeof supported === 'function') {
    try {
      return supported.call(Intl, 'timeZone')
    } catch {
      /* fall through */
    }
  }
  return [
    'UTC',
    'Europe/London',
    'Europe/Dublin',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Madrid',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Toronto',
    'Australia/Sydney',
    'Pacific/Auckland',
  ]
}

/** The browser's own guess. Returns UTC when the runtime will not say. */
export function detectTimeZone(): string {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    return DEFAULT_TIMEZONE
  }
}
