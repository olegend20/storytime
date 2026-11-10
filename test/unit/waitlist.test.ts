import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEnv, resetEnvCache } from '@/lib/env'
import { allLandingCopy, COMING_SOON } from '@/lib/landing/copy'
import { MAX_EMAIL_LENGTH, normalizeEmail } from '@/lib/waitlist/email'
import { handleSignInEmail, type SignInDeps } from '@/lib/waitlist/handlers'
import { inviteMail } from '@/lib/waitlist/invite'
import { waitlistEnabled } from '@/lib/waitlist/mode'

/**
 * Issue #92, the parts with no database: VT-W1 (addresses and the switch), VT-W2 (the
 * coming-soon copy), the invite email's content, and the sign-in route's error branches.
 * The database paths are test/int/waitlist.test.ts.
 */

describe('normalizeEmail (VT-W1)', () => {
  it('trims and lowercases, so one inbox is one row', () => {
    expect(normalizeEmail('  Ana.Lee@Example.COM ')).toBe('ana.lee@example.com')
  })

  it.each([
    ['not an address', 'ana'],
    ['no domain dot', 'ana@example'],
    ['a space inside', 'ana lee@example.com'],
    ['empty', '   '],
    ['not a string', 42],
    ['missing', undefined],
  ])('refuses %s', (_why, raw) => {
    expect(normalizeEmail(raw)).toBeNull()
  })

  it('refuses an address longer than 254 characters', () => {
    const local = 'a'.repeat(MAX_EMAIL_LENGTH)
    expect(normalizeEmail(`${local}@example.com`)).toBeNull()
    expect(normalizeEmail(`${'a'.repeat(MAX_EMAIL_LENGTH - 12)}@example.com`)).not.toBeNull()
  })
})

describe('WAITLIST_ENABLED (VT-W1)', () => {
  const base = {
    ANTHROPIC_API_KEY: 'test-key',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_ANON_KEY: 'test-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    resetEnvCache()
  })

  it('is on when unset: a deployment that forgets it stays closed', () => {
    expect(parseEnv(base).data?.WAITLIST_ENABLED).toBe(true)
  })

  it('is off only when set to false', () => {
    expect(parseEnv({ ...base, WAITLIST_ENABLED: 'false' }).data?.WAITLIST_ENABLED).toBe(false)
    expect(parseEnv({ ...base, WAITLIST_ENABLED: '0' }).data?.WAITLIST_ENABLED).toBe(false)
    expect(parseEnv({ ...base, WAITLIST_ENABLED: 'true' }).data?.WAITLIST_ENABLED).toBe(true)
  })

  it('still answers when the rest of the env is broken, and fails closed', () => {
    vi.stubEnv('SUPABASE_URL', 'not a url')
    resetEnvCache()
    vi.stubEnv('WAITLIST_ENABLED', 'false')
    expect(waitlistEnabled()).toBe(false)
    vi.stubEnv('WAITLIST_ENABLED', 'nonsense')
    expect(waitlistEnabled()).toBe(true)
    vi.stubEnv('WAITLIST_ENABLED', '')
    expect(waitlistEnabled()).toBe(true)
  })
})

describe('the coming-soon page copy (VT-W2)', () => {
  it('is held to the landing copy rules, by being in allLandingCopy()', () => {
    const copy = allLandingCopy()
    for (const line of [COMING_SOON.headline.join(''), COMING_SOON.lead, COMING_SOON.shelf.body, COMING_SOON.note]) {
      expect(copy).toContain(line)
    }
  })

  it('says what the owner asked it to say', () => {
    expect(COMING_SOON.headline.join('')).toMatch(/last ten minutes of the day/)
    expect(COMING_SOON.headline.join('')).toMatch(/you both love/)
    expect(COMING_SOON.lead).toMatch(/curious/)
    expect(COMING_SOON.shelf.headline.join('')).toMatch(/encyclopedia/i)
    expect(COMING_SOON.shelf.body).toMatch(/anything their mind can imagine/)
  })
})

describe('the invite email', () => {
  it('links to sign-in with the address filled in, from the project', () => {
    const mail = inviteMail('ana@example.com', 'hello@lastten.org', 'https://lastten.org')
    expect(mail.to).toBe('ana@example.com')
    expect(mail.from).toBe('The Last Ten <hello@lastten.org>')
    expect(mail.subject).toMatch(/ready/)
    expect(mail.text).toContain('https://lastten.org/login?email=ana%40example.com')
    expect(mail.text).not.toMatch(/password:/i)
  })
})

describe('POST /api/auth/email - the branches that need no database', () => {
  const deps = (sendLink: SignInDeps['sendLink']): SignInDeps => ({
    sendLink,
    // Any database use here is a bug: these branches end before the waitlist is read.
    service: new Proxy({}, { get: () => { throw new Error('database touched') } }) as SignInDeps['service'],
    waitlistOn: true,
  })

  it('400s a bad address without asking Supabase', async () => {
    const send = vi.fn()
    const res = await handleSignInEmail(deps(send), { email: 'nope' })
    expect(res.status).toBe(400)
    expect(send).not.toHaveBeenCalled()
  })

  it('an existing account gets its link and nothing else happens', async () => {
    const send = vi.fn(async () => ({ error: null }))
    const res = await handleSignInEmail(deps(send), { email: 'Ana@Example.com' })
    expect(await res.json()).toEqual({ status: 'sent' })
    expect(send).toHaveBeenCalledExactlyOnceWith('ana@example.com')
  })

  it('passes on a rate limit as a 429 with a kind message', async () => {
    const send = vi.fn(async () => ({ error: { code: 'over_email_send_rate_limit', status: 429, message: 'x' } }))
    const res = await handleSignInEmail(deps(send), { email: 'ana@example.com' })
    expect(res.status).toBe(429)
  })

  it('any other Supabase failure is a 500 that does not leak the cause', async () => {
    const send = vi.fn(async () => ({ error: { code: 'unexpected_failure', status: 500, message: 'secret detail' } }))
    const res = await handleSignInEmail(deps(send), { email: 'ana@example.com' })
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
  })
})
