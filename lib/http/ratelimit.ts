/**
 * F11: IP rate limit on the API, "to stop abuse of the free tier".
 * 30 requests per rolling minute per client IP; the next one gets a 429.
 *
 * Deliberately dependency-free: a sliding-window counter in process memory. That is
 * correct for a single instance (local dev, one Vercel lambda, one container) and is the
 * behaviour the F11 VT asserts. It is NOT shared between instances - a horizontally
 * scaled deployment multiplies the effective limit by the instance count. `RateLimitStore`
 * is the seam for swapping in Upstash (`@upstash/ratelimit`) without touching callers;
 * see `setRateLimitStore`.
 */

/** F11 VT: 30 requests/min from one IP -> 429. */
export const RATE_LIMIT_MAX_REQUESTS = 30
export const RATE_LIMIT_WINDOW_MS = 60_000

/** Ceiling on tracked keys, so a spray of spoofed IPs cannot grow the map forever. */
const MAX_TRACKED_KEYS = 20_000

export interface RateLimitVerdict {
  allowed: boolean
  limit: number
  /** Requests still available in the current window. */
  remaining: number
  /** Whole seconds until the window frees a slot. 0 when allowed. */
  retryAfterSeconds: number
  /** Unix ms at which the oldest counted request leaves the window. */
  resetAt: number
}

export interface RateLimitStore {
  /** Record a hit for `key` at `now` and report whether it is allowed. */
  hit(key: string, now: number): RateLimitVerdict
  reset(): void
}

/** Sliding window of request timestamps per key. */
class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>()

  hit(key: string, now: number): RateLimitVerdict {
    const windowStart = now - RATE_LIMIT_WINDOW_MS
    const existing = this.hits.get(key) ?? []
    // Timestamps are appended in order, so the live tail starts at the first in-window one.
    let firstLive = 0
    while (firstLive < existing.length && existing[firstLive]! <= windowStart) firstLive += 1
    const live = firstLive === 0 ? existing : existing.slice(firstLive)

    if (live.length >= RATE_LIMIT_MAX_REQUESTS) {
      // Over the limit: do not count the rejected request, or a client hammering the
      // endpoint would never drain its window.
      this.hits.set(key, live)
      const oldest = live[0]!
      const resetAt = oldest + RATE_LIMIT_WINDOW_MS
      return {
        allowed: false,
        limit: RATE_LIMIT_MAX_REQUESTS,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
        resetAt,
      }
    }

    live.push(now)
    this.hits.set(key, live)
    if (this.hits.size > MAX_TRACKED_KEYS) this.evictStale(windowStart)
    return {
      allowed: true,
      limit: RATE_LIMIT_MAX_REQUESTS,
      remaining: RATE_LIMIT_MAX_REQUESTS - live.length,
      retryAfterSeconds: 0,
      resetAt: live[0]! + RATE_LIMIT_WINDOW_MS,
    }
  }

  /** Drop keys whose whole window has expired; if that is not enough, drop the oldest. */
  private evictStale(windowStart: number): void {
    for (const [key, stamps] of this.hits) {
      const last = stamps[stamps.length - 1]
      if (last === undefined || last <= windowStart) this.hits.delete(key)
    }
    if (this.hits.size <= MAX_TRACKED_KEYS) return
    const surplus = this.hits.size - MAX_TRACKED_KEYS
    let dropped = 0
    for (const key of this.hits.keys()) {
      this.hits.delete(key)
      dropped += 1
      if (dropped >= surplus) break
    }
  }

  reset(): void {
    this.hits.clear()
  }
}

let store: RateLimitStore = new MemoryRateLimitStore()

/** Swap the backing store (Upstash in a multi-instance deployment; a stub in tests). */
export function setRateLimitStore(next: RateLimitStore): void {
  store = next
}

/** Tests only: forget every counted request. */
export function resetRateLimit(): void {
  store.reset()
}

/**
 * Client IP, trusting only the proxy headers a Vercel/Node deployment actually sets.
 * `x-forwarded-for` is a list appended left to right, so the client is the first entry.
 * Falls back to a single shared bucket, which fails closed (stricter), not open.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return (
    headers.get('x-real-ip')?.trim() ||
    headers.get('cf-connecting-ip')?.trim() ||
    headers.get('x-vercel-forwarded-for')?.trim() ||
    'unknown'
  )
}

/** Count one request against `key` (usually an IP). Pure given `now`, so it is testable. */
export function checkRateLimit(key: string, now: number = Date.now()): RateLimitVerdict {
  return store.hit(key, now)
}

/** Headers every rate-limited response carries, 429 or not. */
export function rateLimitHeaders(verdict: RateLimitVerdict): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(verdict.limit),
    'RateLimit-Remaining': String(verdict.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((verdict.resetAt - Date.now()) / 1000))),
  }
  if (!verdict.allowed) headers['Retry-After'] = String(verdict.retryAfterSeconds)
  return headers
}

/** Parent-facing 429 body. Deliberately vague about the limit itself. */
export const RATE_LIMITED_BODY = {
  code: 'rate_limited',
  message: 'Too many requests just now. Please wait a moment and try again.',
} as const

/**
 * Gate a request. Returns a ready-made 429 `Response` when the caller must be turned
 * away, or `null` when the request may proceed.
 */
export function rateLimitRequest(
  request: Request,
  options: { key?: string; now?: number } = {},
): Response | null {
  const key = options.key ?? clientIp(request.headers)
  const verdict = checkRateLimit(key, options.now ?? Date.now())
  if (verdict.allowed) return null
  return Response.json(RATE_LIMITED_BODY, {
    status: 429,
    headers: rateLimitHeaders(verdict),
  })
}
