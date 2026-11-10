import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEnv, resetEnvCache } from '@/lib/env'
import { allLandingCopy, COMING_SOON } from '@/lib/landing/copy'
import { MAX_EMAIL_LENGTH, normalizeEmail } from '@/lib/waitlist/email'
import { handlePrepareSignIn, type PrepareDeps } from '@/lib/waitlist/handlers'
import { inviteMail } from '@/lib/waitlist/invite'
import { waitlistEnabled } from '@/lib/waitlist/mode'

/**
 * Issue #92, the parts with no database: VT-W1 (addresses and the switch), VT-W2 (the
 * coming-soon copy), the invite email's content, and the prepare route's refusal of bad input.
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

describe('POST /api/auth/prepare - before any database', () => {
  it('400s an address it cannot use, without touching the database', async () => {
    const deps: PrepareDeps = {
      service: new Proxy({}, { get: () => { throw new Error('database touched') } }) as PrepareDeps['service'],
      waitlistOn: true,
    }
    for (const body of [{ email: 'nope' }, {}, null]) {
      expect((await handlePrepareSignIn(deps, body)).status).toBe(400)
    }
  })
})
