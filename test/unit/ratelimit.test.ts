import { beforeEach, describe, expect, it } from 'vitest'
import {
  checkRateLimit,
  clientIp,
  rateLimitHeaders,
  rateLimitRequest,
  resetRateLimit,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
} from '@/lib/http/ratelimit'

/**
 * F11: "rate limit on the API by IP to stop abuse of the free tier", asserted by the VT
 * "30 requests/min from one IP -> 429".
 *
 * The limit is 30 requests per rolling minute, so the 31st request in a window is the one
 * that is refused. These tests pin the window arithmetic; the 429 travelling over real HTTP
 * through `proxy.ts` is covered in test/e2e/api-guards.spec.ts.
 */

const NOW = 1_800_000_000_000

beforeEach(() => {
  resetRateLimit()
})

describe('F11 rate limit window', () => {
  it('is 30 requests per 60 seconds', () => {
    expect(RATE_LIMIT_MAX_REQUESTS).toBe(30)
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000)
  })

  it('allows the first 30 requests in a minute and refuses the 31st', () => {
    for (let i = 1; i <= RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const verdict = checkRateLimit('203.0.113.7', NOW + i)
      expect(verdict.allowed, `request ${i}`).toBe(true)
      expect(verdict.remaining).toBe(RATE_LIMIT_MAX_REQUESTS - i)
    }
    const refused = checkRateLimit('203.0.113.7', NOW + 31)
    expect(refused.allowed).toBe(false)
    expect(refused.remaining).toBe(0)
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  it('keeps refusing while the window is full, without extending it', () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) checkRateLimit('ip-a', NOW)
    const first = checkRateLimit('ip-a', NOW + 1_000)
    const later = checkRateLimit('ip-a', NOW + 2_000)
    expect(first.allowed).toBe(false)
    expect(later.allowed).toBe(false)
    // A rejected request must not be counted, or the window would never drain.
    expect(later.resetAt).toBe(first.resetAt)
  })

  it('lets the caller through again once the window has rolled past', () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) checkRateLimit('ip-b', NOW)
    expect(checkRateLimit('ip-b', NOW + RATE_LIMIT_WINDOW_MS - 1).allowed).toBe(false)
    expect(checkRateLimit('ip-b', NOW + RATE_LIMIT_WINDOW_MS + 1).allowed).toBe(true)
  })

  it('slides rather than resetting on a fixed boundary', () => {
    // 30 requests, one every 2s, so the last lands at NOW+58s.
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) {
      checkRateLimit('ip-c', NOW + i * 2_000)
    }
    // At NOW+78s the window starts at NOW+18s, so the first ten have aged out and exactly
    // ten slots are free again - a fixed-window counter would have freed all thirty.
    let allowed = 0
    for (let i = 0; i < 20; i += 1) {
      if (checkRateLimit('ip-c', NOW + 78_000).allowed) allowed += 1
    }
    expect(allowed).toBe(10)
  })

  it('counts each IP separately', () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) checkRateLimit('ip-noisy', NOW)
    expect(checkRateLimit('ip-noisy', NOW).allowed).toBe(false)
    expect(checkRateLimit('ip-quiet', NOW).allowed).toBe(true)
  })
})

describe('F11 rate limit response', () => {
  it('returns null while the caller is inside the limit', () => {
    const request = new Request('http://localhost/api/children', {
      headers: { 'x-forwarded-for': '198.51.100.4' },
    })
    expect(rateLimitRequest(request, { now: NOW })).toBeNull()
  })

  it('returns a 429 with Retry-After and a parent-safe message', async () => {
    const headers = { 'x-forwarded-for': '198.51.100.9' }
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const ok = rateLimitRequest(new Request('http://localhost/api/children', { headers }), {
        now: NOW,
      })
      expect(ok).toBeNull()
    }
    const response = rateLimitRequest(new Request('http://localhost/api/children', { headers }), {
      now: NOW,
    })
    expect(response).not.toBeNull()
    expect(response!.status).toBe(429)
    expect(Number(response!.headers.get('Retry-After'))).toBeGreaterThan(0)
    const body = (await response!.json()) as { code: string; message: string }
    expect(body.code).toBe('rate_limited')
    // Never tell an abuser what the limit is.
    expect(body.message).not.toMatch(/30|minute/i)
  })

  it('sets RateLimit-* headers on an allowed verdict too', () => {
    const verdict = checkRateLimit('ip-headers', NOW)
    const headers = rateLimitHeaders(verdict)
    expect(headers['RateLimit-Limit']).toBe('30')
    expect(headers['RateLimit-Remaining']).toBe('29')
    expect(headers['Retry-After']).toBeUndefined()
  })
})

describe('F11 client IP extraction', () => {
  it('takes the first entry of x-forwarded-for, which is the client', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.5, 70.41.3.18, 150.172.238.178' })
    expect(clientIp(headers)).toBe('203.0.113.5')
  })

  it('falls back through the other proxy headers', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '203.0.113.6' }))).toBe('203.0.113.6')
    expect(clientIp(new Headers({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7')
  })

  it('uses one shared bucket when no proxy header is present, which fails closed', () => {
    expect(clientIp(new Headers())).toBe('unknown')
  })

  it('ignores an empty x-forwarded-for rather than keying on an empty string', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '' }))).toBe('unknown')
  })
})
