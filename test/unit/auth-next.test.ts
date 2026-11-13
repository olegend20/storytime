import { NextRequest, NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NEXT, NEXT_COOKIE, resolveNext, safeNext } from '@/lib/auth/next'
import { resetEnvCache } from '@/lib/env'

/**
 * VT-L2 (issue #101): the emailed link on lastten.org, handed on to Supabase's check, and
 * where the callback sends a parent afterwards. The link cannot carry `next`, so the login
 * form leaves it in a cookie; neither source may become an open redirect.
 */

describe('resolveNext', () => {
  it('takes ?next= first, then the cookie (already decoded by Next), then the dashboard', () => {
    expect(resolveNext('/library', '/children')).toBe('/library')
    expect(resolveNext(null, '/children')).toBe('/children')
    expect(resolveNext(null, '/stories?title=100%25')).toBe('/stories?title=100%25')
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
    expect(resolveNext(null, bad)).toBe(DEFAULT_NEXT)
  })

  it('a bad ?next= does not fall back to the cookie (the link wins, safely)', () => {
    expect(resolveNext('//evil.example', '/library')).toBe(DEFAULT_NEXT)
  })
})

describe('/auth/link: the emailed link hands on to Supabase (VT-L2)', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://ref.supabase.co')
    vi.stubEnv('SITE_URL', '')
    resetEnvCache()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvCache()
  })

  async function link(query: string) {
    const { GET } = await import('@/app/auth/link/route')
    return GET(
      new NextRequest(`http://localhost:3000/auth/link?${query}`, {
        headers: { host: 'lastten.org', 'x-forwarded-proto': 'https' },
      }),
    )
  }

  it.each(['magiclink', 'signup'])('passes a %s token to Supabase, coming back to the host it was opened on', async (type) => {
    const res = await link(`token_hash=pkce_abc123def456&type=${type}`)
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(to.origin + to.pathname).toBe('https://ref.supabase.co/auth/v1/verify')
    expect(to.searchParams.get('token')).toBe('pkce_abc123def456')
    expect(to.searchParams.get('type')).toBe(type)
    expect(to.searchParams.get('redirect_to')).toBe('https://lastten.org/auth/callback')
  })

  it.each([
    'type=magiclink',
    'token_hash=pkce_abc123def456',
    'token_hash=pkce_abc123def456&type=recovery',
    'token_hash=pkce_abc123def456&type=invite',
    'token_hash=pkce_abc123def456&type=email_change',
    'token_hash=abc%22%3E%3Cx&type=magiclink',
  ])('anything else goes back to the login page: %s', async (query) => {
    const res = await link(query)
    expect(res.headers.get('location')).toMatch(/^\/login\?error=/)
  })
})

// The callback route, with Supabase and the family service stubbed: only its redirect and
// cookie handling are under test here; the real verification runs in the e2e.
const verifyOtp = vi.fn()
const exchangeCodeForSession = vi.fn()
const getUser = vi.fn()
vi.mock('@/lib/supabase/route', () => ({
  supabaseRoute: () => ({
    db: { auth: { verifyOtp, getUser, exchangeCodeForSession } },
    commit: (response: Response) =>
      new NextResponse(response.body, { status: response.status, headers: response.headers }),
  }),
}))
vi.mock('@/lib/family/service', () => ({ ensureFamily: vi.fn(async () => undefined) }))

async function callback(query: string, cookie?: string) {
  const { GET } = await import('@/app/auth/callback/route')
  const headers = cookie ? { cookie: `${NEXT_COOKIE}=${encodeURIComponent(cookie)}` } : undefined
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
    exchangeCodeForSession.mockReset()
    getUser.mockReset()
  })

  it('after Supabase’s check: goes to the remembered page and clears it', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    const res = await callback('code=c1', '/stories?title=100%25')
    expect(res.headers.get('location')).toBe('/stories?title=100%25')
    expect(clearsNextCookie(res)).toBe(true)
  })

  it('a remembered page that points off the site goes to the dashboard', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null })
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    const res = await callback('code=c1', '//evil.example')
    expect(res.headers.get('location')).toBe(DEFAULT_NEXT)
  })

  it('a code that fails (another browser, or used) says where to open it, and keeps the remembered page', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: 'bad verifier' } })
    const { CODE_FAILED } = await import('@/app/auth/callback/route')
    const res = await callback('code=c1', '/library')
    expect(res.headers.get('location')).toBe(`/login?error=${encodeURIComponent(CODE_FAILED)}`)
    expect(CODE_FAILED).toMatch(/device and browser you asked from/)
    expect(clearsNextCookie(res)).toBe(false)
  })

  it('a token_hash never signs in: only a code from the asking browser does (DECISIONS #219)', async () => {
    for (const type of ['magiclink', 'signup', 'email', 'recovery']) {
      const res = await callback(`token_hash=abc&type=${type}`)
      expect(verifyOtp, type).not.toHaveBeenCalled()
      expect(getUser, type).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toMatch(/^\/login\?error=/)
    }
  })
})

describe('/auth/link on 127.0.0.1', () => {
  it('comes back to 127.0.0.1, not localhost: the verifier cookie is on the origin the browser used', async () => {
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54321')
    resetEnvCache()
    const { GET } = await import('@/app/auth/link/route')
    const res = GET(new NextRequest('http://localhost:3000/auth/link?token_hash=pkce_abc123def456&type=magiclink', { headers: { host: '127.0.0.1:3000' } }))
    expect(new URL(res.headers.get('location')!).searchParams.get('redirect_to')).toBe('http://127.0.0.1:3000/auth/callback')
    vi.unstubAllEnvs()
    resetEnvCache()
  })
})

describe('/auth/link with SITE_URL set (production)', () => {
  it('always returns to SITE_URL, whatever Host the request claims', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://ref.supabase.co')
    vi.stubEnv('SITE_URL', 'https://lastten.org')
    resetEnvCache()
    const { GET } = await import('@/app/auth/link/route')
    const res = GET(
      new NextRequest('https://lastten.org/auth/link?token_hash=pkce_abc123def456&type=magiclink', {
        headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
      }),
    )
    expect(new URL(res.headers.get('location')!).searchParams.get('redirect_to')).toBe('https://lastten.org/auth/callback')
    vi.unstubAllEnvs()
    resetEnvCache()
  })
})
