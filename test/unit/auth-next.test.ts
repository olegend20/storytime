import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NEXT, NEXT_COOKIE, resolveNext, safeNext } from '@/lib/auth/next'

/**
 * VT-L2 (issue #101): where the callback sends a parent after signing in. The emailed link
 * cannot carry `next`, so the login form leaves it in a cookie; neither source may become an
 * open redirect.
 */

describe('resolveNext', () => {
  it('takes ?next= first, then the cookie, then the dashboard', () => {
    expect(resolveNext('/library', '%2Fchildren')).toBe('/library')
    expect(resolveNext(null, '%2Fchildren')).toBe('/children')
    expect(resolveNext(null, '/stories/abc')).toBe('/stories/abc')
    expect(resolveNext(null, null)).toBe(DEFAULT_NEXT)
    expect(resolveNext('', '')).toBe(DEFAULT_NEXT)
  })

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/library\nSet-Cookie: x=1',
    'library',
  ])('never redirects off the site: %j', (bad) => {
    expect(safeNext(bad)).toBe(DEFAULT_NEXT)
    expect(resolveNext(bad, null)).toBe(DEFAULT_NEXT)
    expect(resolveNext(null, encodeURIComponent(bad))).toBe(DEFAULT_NEXT)
  })

  it('a bad ?next= does not fall back to the cookie (the link wins, safely)', () => {
    expect(resolveNext('//evil.example', '%2Flibrary')).toBe(DEFAULT_NEXT)
  })

  it('an undecodable cookie is ignored', () => {
    expect(resolveNext(null, '%E0%A4%A')).toBe(DEFAULT_NEXT)
  })
})

// The callback route, with Supabase and the family service stubbed: only its redirect and
// cookie handling are under test here; the real verification runs in the e2e.
const verifyOtp = vi.fn()
const getUser = vi.fn()
vi.mock('@/lib/supabase/route', () => ({
  supabaseRoute: () => ({
    db: { auth: { verifyOtp, getUser, exchangeCodeForSession: vi.fn() } },
    commit: (response: Response) =>
      new NextResponse(response.body, { status: response.status, headers: response.headers }),
  }),
}))
vi.mock('@/lib/family/service', () => ({ ensureFamily: vi.fn(async () => undefined) }))

async function callback(query: string, cookie?: string) {
  const { GET } = await import('@/app/auth/callback/route')
  const headers = cookie ? { cookie: `${NEXT_COOKIE}=${cookie}` } : undefined
  return GET(new NextRequest(`http://localhost/auth/callback?${query}`, { headers }))
}

function clearsNextCookie(response: Response): boolean {
  return (response.headers.get('set-cookie') ?? '').split(/,(?=\s*\w+=)/).some((c) =>
    new RegExp(`^\\s*${NEXT_COOKIE}=;`).test(c) && /(Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(c),
  )
}

describe('the callback (VT-L2)', () => {
  beforeEach(() => {
    verifyOtp.mockReset()
    getUser.mockReset()
  })

  it('verifies the emailed token_hash as type=email, goes to the remembered page, and clears it', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    const res = await callback('token_hash=abc&type=email', '%2Flibrary')
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'email', token_hash: 'abc' })
    expect(res.headers.get('location')).toBe('/library')
    expect(clearsNextCookie(res)).toBe(true)
  })

  it('with no type on the link, still verifies as type=email', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    await callback('token_hash=abc')
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'email', token_hash: 'abc' })
  })

  it('a remembered page that points off the site goes to the dashboard', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    const res = await callback('token_hash=abc&type=email', encodeURIComponent('//evil.example'))
    expect(res.headers.get('location')).toBe(DEFAULT_NEXT)
  })

  it('an expired or used link goes to the login page with a message, and clears the cookie', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'expired' } })
    const res = await callback('token_hash=abc&type=email', '%2Flibrary')
    expect(res.headers.get('location')).toMatch(/^\/login\?error=.*expired/)
    expect(clearsNextCookie(res)).toBe(true)
  })
})
