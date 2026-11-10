import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'
import { anon, applyTestSupabaseEnv, dbReachable, service, SKIP_REASON, testSupabaseEnv } from '../helpers/db'

/**
 * Issue #92 integration VTs, against the local Supabase: the waitlist table, the three route
 * bodies with the real clients, the owner gate on the approve route, and Supabase's own
 * sign-up switched off.
 *
 * The approve route's auth lookup is stubbed (no HTTP request, so no cookie store), as in
 * test/int/admin.test.ts; everything else is real.
 */

const session = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }) },
  }),
}))

const { handleApprove, handleJoinWaitlist, handlePrepareSignIn } = await import('@/lib/waitlist/handlers')
const { POST: approveRoute } = await import('@/app/api/admin/waitlist/route')
type InviteMail = import('@/lib/waitlist/invite').InviteMail

applyTestSupabaseEnv()
const reachable = await dbReachable()
if (!reachable) console.warn(`[skip] test/int/waitlist.test.ts - ${SKIP_REASON}`)

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const made: string[] = []
const address = (label: string) => {
  const email = `waitlist-${label}-${RUN}@storytime.test`
  made.push(email)
  return email
}

const savedOwner = process.env.OWNER_USER_ID
afterEach(() => {
  session.userId = null
  if (savedOwner === undefined) delete process.env.OWNER_USER_ID
  else process.env.OWNER_USER_ID = savedOwner
})

/** The auth user with this address, or null - through the admin API, never by signing in. */
async function findUser(email: string): Promise<{ id: string } | null> {
  const { url, serviceKey } = testSupabaseEnv()
  const res = await fetch(`${url}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  })
  const body = (await res.json()) as { users?: { id: string; email: string }[] }
  return body.users?.find((u) => u.email === email) ?? null
}

async function row(email: string) {
  const { data } = await service().from('waitlist').select('*').eq('email', email).maybeSingle()
  return data as { email: string; approved_at: string | null; invited_at: string | null } | null
}

afterAll(async () => {
  if (!reachable) return
  const db = service()
  for (const email of made) {
    const user = await findUser(email)
    if (user) await db.auth.admin.deleteUser(user.id)
  }
  await db.from('waitlist').delete().in('email', made)
})

/** The real link request, as the login form makes it: never creating anyone. */
async function requestLink(email: string): Promise<string | null> {
  const { error } = await anon().auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  return error ? (error.code ?? 'error') : null
}

describe.runIf(reachable)('POST /api/waitlist (VT-W3)', () => {
  it('stores the address once, normalised', async () => {
    const email = address('join')
    const first = await handleJoinWaitlist(service(), { email: `  ${email.toUpperCase()} ` })
    const again = await handleJoinWaitlist(service(), { email })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual(await again.json())
    const { data } = await service().from('waitlist').select('email').eq('email', email)
    expect(data).toHaveLength(1)
    expect((await row(email))?.approved_at).toBeNull()
  })

  it('answers an approved address exactly like a new one (no enumeration)', async () => {
    const email = address('known')
    await service().from('waitlist').insert({ email, approved_at: new Date().toISOString() })
    const known = await handleJoinWaitlist(service(), { email })
    const fresh = await handleJoinWaitlist(service(), { email: address('fresh') })
    expect(known.status).toBe(fresh.status)
    expect(await known.json()).toEqual(await fresh.json())
  })

  it('400s an address it cannot use', async () => {
    for (const body of [{ email: 'nope' }, {}, null, 'ana@example.com']) {
      expect((await handleJoinWaitlist(service(), body)).status).toBe(400)
    }
  })

  it('accepts a filled honeypot without storing anything', async () => {
    const email = address('bot')
    const res = await handleJoinWaitlist(service(), { email, website: 'http://spam.example' })
    expect(res.status).toBe(200)
    expect(await row(email)).toBeNull()
  })
})

describe.runIf(reachable)('the waitlist table is the server’s alone (VT-W6)', () => {
  it('anon cannot read or add rows', async () => {
    const email = address('rls')
    await service().from('waitlist').insert({ email })
    const read = await anon().from('waitlist').select('email').eq('email', email)
    expect(read.data ?? []).toHaveLength(0)
    const write = await anon().from('waitlist').insert({ email: address('rls-write') })
    expect(write.error).not.toBeNull()
  })

  it('an approved row cannot be forged by a signed-in parent either', async () => {
    const email = address('rls-user')
    const created = await service().auth.admin.createUser({ email, password: 'correct-horse-battery-9', email_confirm: true })
    expect(created.error).toBeNull()
    const { url, anonKey } = testSupabaseEnv()
    const parent = createClient(url, anonKey, { auth: { persistSession: false } })
    await parent.auth.signInWithPassword({ email, password: 'correct-horse-battery-9' })
    const forged = await parent.from('waitlist').insert({ email, approved_at: new Date().toISOString() })
    expect(forged.error).not.toBeNull()
    expect(await row(email)).toBeNull()
  })

  it('rejects an address that is not stored lowercased', async () => {
    const { error } = await service().from('waitlist').insert({ email: `Mixed-${RUN}@Storytime.test` })
    expect(error?.code).toBe('23514')
  })
})

describe.runIf(reachable)('POST /api/auth/prepare and the login form’s flow (VT-W4)', () => {
  const prepare = (waitlistOn: boolean, email: string) =>
    handlePrepareSignIn({ service: service(), waitlistOn }, { email })

  it('an address that is not approved gets no account, and its link never comes', async () => {
    const email = address('unapproved')
    await handleJoinWaitlist(service(), { email }) // waiting, not approved
    expect(await requestLink(email)).toMatch(/signup_disabled|otp_disabled/)
    const res = await prepare(true, email)
    expect(await res.json()).toEqual({ ok: true })
    expect(await findUser(email)).toBeNull()
    expect(await requestLink(email)).toMatch(/signup_disabled|otp_disabled/)
  })

  it('an approved address gets an account, and then its link', async () => {
    const email = address('approved')
    await service().from('waitlist').insert({ email, approved_at: new Date().toISOString() })
    expect(await requestLink(email)).not.toBeNull()
    expect(await (await prepare(true, email.toUpperCase())).json()).toEqual({ ok: true })
    expect(await findUser(email)).not.toBeNull()
    expect(await requestLink(email)).toBeNull()
  })

  it('answers every address the same, so it cannot be used to learn who is approved', async () => {
    const approved = address('same-a')
    await service().from('waitlist').insert({ email: approved, approved_at: new Date().toISOString() })
    const answers = await Promise.all(
      [approved, address('same-b')].map(async (e) => {
        const r = await prepare(true, e)
        return [r.status, await r.json()]
      }),
    )
    expect(answers[0]).toEqual(answers[1])
  })

  it('an account from before the waitlist needs nothing: its link comes straight away', async () => {
    const email = address('existing')
    await service().auth.admin.createUser({ email, email_confirm: true })
    expect(await requestLink(email)).toBeNull()
    // And a prepare for it is harmless (the account already exists).
    expect((await prepare(true, email)).status).toBe(200)
    expect(await row(email)).toBeNull()
  })

  it('with the waitlist off, anyone gets an account', async () => {
    const email = address('open')
    expect(await (await prepare(false, email)).json()).toEqual({ ok: true })
    expect(await findUser(email)).not.toBeNull()
    expect((await prepare(false, email)).status).toBe(200) // twice is fine
  })
})

describe.runIf(reachable)('approving (VT-W5)', () => {
  const recorder = () => {
    const sent: InviteMail[] = []
    return { sent, sender: { send: async (m: InviteMail) => void sent.push(m) } }
  }

  it('approves once and sends one invite, recording when', async () => {
    const email = address('invite')
    await handleJoinWaitlist(service(), { email })
    const { sent, sender } = recorder()
    vi.stubEnv('MAIL_FROM_EMAIL', 'hello@storytime.local')
    try {
      const deps = { service: service(), sender, origin: 'https://lastten.example' }
      const first = await (await handleApprove(deps, { email })).json()
      const second = await (await handleApprove(deps, { email })).json()
      expect(first).toEqual({ approved: true, emailed: true, alreadyInvited: false })
      expect(second).toEqual({ approved: true, emailed: false, alreadyInvited: true })
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe(email)
      expect(sent[0]!.text).toContain('https://lastten.example/login?email=')
      const stored = await row(email)
      expect(stored?.approved_at).not.toBeNull()
      expect(stored?.invited_at).not.toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('two presses at once send one invite', async () => {
    const email = address('race')
    const { sent, sender } = recorder()
    vi.stubEnv('MAIL_FROM_EMAIL', 'hello@storytime.local')
    try {
      const deps = { service: service(), sender, origin: 'https://x.example' }
      const results = await Promise.all([handleApprove(deps, { email }), handleApprove(deps, { email })])
      const bodies = await Promise.all(results.map((r) => r.json()))
      expect(sent).toHaveLength(1)
      expect(bodies.filter((b) => b.emailed)).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('with no mail it still approves, says so, and sends the invite later on a second press', async () => {
    const email = address('nomail')
    const noMail = await (await handleApprove({ service: service(), sender: null, origin: 'https://x.example' }, { email })).json()
    expect(noMail).toEqual({ approved: true, emailed: false, alreadyInvited: false })
    expect((await row(email))?.invited_at).toBeNull()

    const { sent, sender } = recorder()
    vi.stubEnv('MAIL_FROM_EMAIL', 'hello@storytime.local')
    try {
      const later = await (await handleApprove({ service: service(), sender, origin: 'https://x.example' }, { email })).json()
      expect(later.emailed).toBe(true)
      expect(sent).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('a failed send leaves the approval in place and the invite unsent', async () => {
    const email = address('sendfail')
    vi.stubEnv('MAIL_FROM_EMAIL', 'hello@storytime.local')
    try {
      const failing = { send: async () => { throw new Error('smtp down') } }
      const res = await (await handleApprove({ service: service(), sender: failing, origin: 'https://x.example' }, { email })).json()
      expect(res).toEqual({ approved: true, emailed: false, alreadyInvited: false })
      const stored = await row(email)
      expect(stored?.approved_at).not.toBeNull()
      expect(stored?.invited_at).toBeNull()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  const post = (email: string) =>
    approveRoute(
      new NextRequest('http://localhost/api/admin/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
    )

  it('the route 404s for a parent, for nobody, and when no owner is set', async () => {
    const email = address('gate')
    process.env.OWNER_USER_ID = '00000000-0000-4000-8000-0000000000aa'
    session.userId = '00000000-0000-4000-8000-0000000000bb'
    expect((await post(email)).status).toBe(404)
    session.userId = null
    expect((await post(email)).status).toBe(404)
    delete process.env.OWNER_USER_ID
    session.userId = '00000000-0000-4000-8000-0000000000aa'
    expect((await post(email)).status).toBe(404)
    expect(await row(email)).toBeNull()
  })

  it('the route approves for the owner', async () => {
    const email = address('owner')
    process.env.OWNER_USER_ID = '00000000-0000-4000-8000-0000000000aa'
    session.userId = '00000000-0000-4000-8000-0000000000aa'
    const res = await post(email)
    expect(res.status).toBe(200)
    expect((await res.json()).approved).toBe(true)
    expect((await row(email))?.approved_at).not.toBeNull()
  })
})
