import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import proxy from '@/proxy'
import { RATE_LIMIT_MAX_REQUESTS, resetRateLimit } from '@/lib/http/ratelimit'

/**
 * Issue #92: signing in and joining the waitlist go through our API, so they are rate-limited
 * in a bucket of their own. A busy dashboard on the same network must not lock a parent out
 * of signing in - the e2e suite found exactly that - and sign-in attempts must not starve the
 * rest of the API either. Both buckets still have a limit.
 *
 * With no Supabase URL the proxy stops right after the limiter, so no network is touched.
 */

const ip = '203.0.113.92'
const call = (path: string) =>
  proxy(new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'x-forwarded-for': ip } }))

beforeEach(() => {
  resetRateLimit()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetRateLimit()
})

describe('the sign-in bucket (issue #92)', () => {
  it('a sign-in still goes through when the API budget for that address is spent', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) await call('/api/health')
    expect((await call('/api/health')).status).toBe(429)
    expect((await call('/api/auth/prepare')).status).not.toBe(429)
    expect((await call('/api/waitlist')).status).not.toBe(429)
  })

  it('and has a limit of its own', async () => {
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) await call(i % 2 ? '/api/auth/prepare' : '/api/waitlist')
    expect((await call('/api/auth/prepare')).status).toBe(429)
    expect((await call('/api/health')).status).not.toBe(429)
  })
})
