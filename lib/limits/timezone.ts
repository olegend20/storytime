/**
 * F8: the daily quota boundary is midnight in the FAMILY'S OWN timezone, not UTC.
 *
 * Getting this wrong is not cosmetic. At 23:30 in `Pacific/Auckland` it is still the
 * previous morning in `America/Los_Angeles`; if both families were bucketed by the UTC
 * date, one of them would silently get up to six stories in their own day and the other
 * would lose an evening. Everything here is `Intl`-based — no date library, no offset
 * table to go stale when a government moves a DST boundary.
 */

const UTC = 'UTC'

/** `Intl` throws on an unknown zone; families.timezone defaults to 'UTC' but is free text. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * Falls back to UTC rather than throwing: a bad timezone string must never be the reason
 * a parent cannot get a bedtime story. The fallback is loud in the server log.
 */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (timeZone && isValidTimeZone(timeZone)) return timeZone
  if (timeZone) {
    console.warn(`[limits] unknown timezone ${JSON.stringify(timeZone)}; falling back to UTC`)
  }
  return UTC
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsCache.set(timeZone, f)
  }
  return f
}

/** Wall-clock fields in `timeZone` at the given instant. */
export function zonedParts(timeZone: string, at: Date = new Date()): ZonedParts {
  const parts = formatter(safeTimeZone(timeZone)).formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    return found ? Number(found.value) : 0
  }
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** How far ahead of UTC `timeZone` is at that instant, in milliseconds. */
function offsetMs(timeZone: string, at: Date): number {
  const p = zonedParts(timeZone, at)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // Discard sub-second precision on both sides so the difference is a clean offset.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000
}

/**
 * The instant at which a given wall-clock time in `timeZone` occurs.
 * Two passes, because the offset we need is the one in effect AT the target local time,
 * not at our first guess — that is what makes the DST-transition days come out right.
 */
export function zonedTimeToUtc(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const tz = safeTimeZone(timeZone)
  const guess = Date.UTC(y, m - 1, d, hour, minute, second)
  let ts = guess - offsetMs(tz, new Date(guess))
  ts = guess - offsetMs(tz, new Date(ts))
  return new Date(ts)
}

/**
 * The `daily_usage.usage_date` for an instant, as `YYYY-MM-DD` in the family's timezone.
 * This is the value the quota is keyed on.
 */
export function usageDateFor(timeZone: string, at: Date = new Date()): string {
  const p = zonedParts(timeZone, at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * Next local midnight after `at`, as an instant. This is the "local reset time" the 429
 * body has to carry (F8 AC) — a parent in Auckland must not be told their stories come
 * back at 5pm.
 */
export function nextLocalMidnight(timeZone: string, at: Date = new Date()): Date {
  const p = zonedParts(timeZone, at)
  // Day + 1 with Date.UTC normalising month/year rollover for us.
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1))
  return zonedTimeToUtc(
    timeZone,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    0,
    0,
    0,
  )
}

/** ISO 8601 form of the reset instant, for the API contract's `resets_at`. */
export function nextResetAtIso(timeZone: string, at: Date = new Date()): string {
  return nextLocalMidnight(timeZone, at).toISOString()
}
