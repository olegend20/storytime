import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTestSupabaseEnv, dbReachable, service, SKIP_REASON } from '../helpers/db'
import { resetEnvCache } from '@/lib/env'
import { handleApprove, handleConfirm, handleJoinWaitlist, type JoinDeps } from '@/lib/waitlist/handlers'
import { hashConfirmToken } from '@/lib/waitlist/confirm'
import type { InviteMail, InviteSender } from '@/lib/waitlist/invite'
import { approve, listWaitlist, purgeUnconfirmed } from '@/lib/waitlist/store'

/**
 * Issue #95 integration VTs, against the local Supabase: the double opt-in. Joining emails a
 * one-time link (VT-W10), the link confirms once (VT-W11), and only confirmed addresses reach
 * the owner's list (VT-W12). Mail goes to a recorder; everything else is real.
 */

applyTestSupabaseEnv()
const reachable = await dbReachable()
if (!reachable) console.warn(`[skip] test/int/waitlist-confirm.test.ts - ${SKIP_REASON}`)

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
const made: string[] = []
const address = (label: string) => {
  const email = `optin-${label}-${RUN}@storytime.test`
  made.push(email)
  return email
}

beforeEach(() => {
  vi.stubEnv('MAIL_FROM_EMAIL', 'hello@storytime.local')
  resetEnvCache()
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetEnvCache()
})
afterAll(async () => {
  if (reachable) await service().from('waitlist').delete().in('email', made)
})

interface Row {
  email: string
  created_at: string
  approved_at: string | null
  confirmed_at: string | null
  confirm_token_hash: string | null
  confirm_sent_at: string | null
}
async function row(email: string): Promise<Row | null> {
  const { data } = await service().from('waitlist').select('*').eq('email', email).maybeSingle()
  return data as Row | null
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function recorder(): { sent: InviteMail[]; sender: InviteSender } {
  const sent: InviteMail[] = []
  return { sent, sender: { send: async (m) => void sent.push(m) } }
}
// No daily cap here (leftovers from other runs must not flake these); the cap has its own test.
const deps = (sender: InviteSender | null): JoinDeps => ({
  service: service(),
  sender,
  origin: 'https://lastten.example',
  dailyCap: Number.MAX_SAFE_INTEGER,
})
const tokenIn = (mail: InviteMail): string => {
  const link = mail.text.match(/https:\/\/lastten\.example\/waitlist\/confirm\?token=(\S+)/)
  expect(link, 'the email links to the confirm page').not.toBeNull()
  return decodeURIComponent(link![1]!)
}
const confirm = async (token: string) => {
  const res = await handleConfirm(service(), { token })
  return { status: res.status, body: await res.json() }
}

describe.runIf(reachable)('joining sends one confirmation email (VT-W10)', () => {
  it('emails a link and stores only its hash', async () => {
    const email = address('first')
    const { sent, sender } = recorder()
    const res = await handleJoinWaitlist(deps(sender), { email })
    expect(await res.json()).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(email)
    expect(sent[0]!.from).toBe('The Last Ten <hello@storytime.local>')
    expect(sent[0]!.subject).toMatch(/Confirm your place/)
    const token = tokenIn(sent[0]!)
    const stored = await row(email)
    expect(stored?.confirm_token_hash).toBe(hashConfirmToken(token))
    expect(JSON.stringify(stored)).not.toContain(token)
    expect(stored?.confirm_sent_at).not.toBeNull()
    expect(stored?.confirmed_at).toBeNull()
  })

  it('joining again within a day sends nothing more, and the first link still works', async () => {
    const email = address('again')
    const { sent, sender } = recorder()
    await handleJoinWaitlist(deps(sender), { email })
    await handleJoinWaitlist(deps(sender), { email })
    await handleJoinWaitlist(deps(sender), { email: email.toUpperCase() })
    expect(sent).toHaveLength(1)
    expect((await confirm(tokenIn(sent[0]!))).status).toBe(200)
  })

  it('a day later it sends a fresh link, and the old one stops working', async () => {
    const email = address('day-later')
    const { sent, sender } = recorder()
    await handleJoinWaitlist(deps(sender), { email })
    await service().from('waitlist').update({ confirm_sent_at: ago(25 * HOUR) }).eq('email', email)
    await handleJoinWaitlist(deps(sender), { email })
    expect(sent).toHaveLength(2)
    expect((await confirm(tokenIn(sent[0]!))).status).toBe(400)
    expect((await confirm(tokenIn(sent[1]!))).status).toBe(200)
  })

  it('two joins at once send one email', async () => {
    const email = address('race')
    const { sent, sender } = recorder()
    await Promise.all([1, 2, 3].map(() => handleJoinWaitlist(deps(sender), { email })))
    expect(sent).toHaveLength(1)
  })

  it('a confirmed or approved address is never emailed again', async () => {
    const confirmed = address('confirmed')
    const approved = address('approved')
    await service().from('waitlist').insert([
      { email: confirmed, confirmed_at: new Date().toISOString() },
      { email: approved, approved_at: new Date().toISOString(), confirmed_at: new Date().toISOString() },
    ])
    const { sent, sender } = recorder()
    await handleJoinWaitlist(deps(sender), { email: confirmed })
    await handleJoinWaitlist(deps(sender), { email: approved })
    expect(sent).toHaveLength(0)
  })

  it('a failed send gives the claim back, so joining again sends', async () => {
    const email = address('sendfail')
    const failing: InviteSender = { send: async () => { throw new Error('smtp down') } }
    const res = await handleJoinWaitlist(deps(failing), { email })
    expect(await res.json()).toEqual({ ok: true })
    expect((await row(email))?.confirm_sent_at).toBeNull()
    expect((await row(email))?.confirm_token_hash).toBeNull()
    const { sent, sender } = recorder()
    await handleJoinWaitlist(deps(sender), { email })
    expect(sent).toHaveLength(1)
  })

  it('with no mail set up the address goes straight onto the list, as before #95', async () => {
    const email = address('nomail')
    expect(await (await handleJoinWaitlist(deps(null), { email })).json()).toEqual({ ok: true })
    const stored = await row(email)
    expect(stored?.confirmed_at).not.toBeNull()
    expect(stored?.confirm_sent_at).toBeNull()
    expect((await listWaitlist(service())).waiting.map((r) => r.email)).toContain(email)
  })

  it('someone whose link expired gets a fresh one by joining again (code review)', async () => {
    const email = address('rejoin')
    const week = ago(8 * DAY)
    await service().from('waitlist').insert({ email, created_at: week, confirm_sent_at: week, confirm_token_hash: 'f'.repeat(64) })
    const { sent, sender } = recorder()
    await handleJoinWaitlist(deps(sender), { email })
    expect(sent.map((m) => m.to)).toEqual([email])
    expect((await confirm(tokenIn(sent[0]!))).status).toBe(200)
  })

  it('in production the email goes after the answer: the answer cannot wait on SMTP', async () => {
    const email = address('deferred')
    const { sent, sender } = recorder()
    const tasks: (() => Promise<void>)[] = []
    const res = await handleJoinWaitlist({ ...deps(sender), defer: (t) => void tasks.push(t) }, { email })
    expect(await res.json()).toEqual({ ok: true })
    expect(sent).toHaveLength(0)
    expect(tasks).toHaveLength(1)
    await tasks[0]!()
    expect(sent.map((m) => m.to)).toEqual([email])
  })

  it('answers every case the same: new, repeat, confirmed, approved, failed send, honeypot', async () => {
    const confirmed = address('same-confirmed')
    await service().from('waitlist').insert({ email: confirmed, confirmed_at: new Date().toISOString() })
    const { sender } = recorder()
    const failing: InviteSender = { send: async () => { throw new Error('down') } }
    const repeat = address('same-repeat')
    await handleJoinWaitlist(deps(sender), { email: repeat })
    const answers = await Promise.all([
      handleJoinWaitlist(deps(sender), { email: address('same-new') }),
      handleJoinWaitlist(deps(sender), { email: repeat }),
      handleJoinWaitlist(deps(sender), { email: confirmed }),
      handleJoinWaitlist(deps(failing), { email: address('same-fail') }),
      handleJoinWaitlist(deps(sender), { email: address('same-bot'), website: 'x' }),
    ])
    const bodies = await Promise.all(answers.map(async (r) => [r.status, await r.json()]))
    for (const b of bodies) expect(b).toEqual([200, { ok: true }])
  })
})

describe.runIf(reachable)('the link confirms once (VT-W11)', () => {
  async function joined(label: string): Promise<{ email: string; token: string }> {
    const email = address(label)
    const { sent, sender } = recorder()
    await handleJoinWaitlist(deps(sender), { email })
    return { email, token: tokenIn(sent[0]!) }
  }

  it('the right token confirms the address, once', async () => {
    const { email, token } = await joined('once')
    expect(await confirm(token)).toEqual({ status: 200, body: { confirmed: true } })
    const stored = await row(email)
    expect(stored?.confirmed_at).not.toBeNull()
    expect(stored?.confirm_token_hash).toBeNull()
    expect((await confirm(token)).status).toBe(400)
  })

  it('two presses at once confirm once', async () => {
    const { token } = await joined('double')
    const results = await Promise.all([confirm(token), confirm(token)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 400])
  })

  it('a wrong token, a malformed one and a week-old one all get the same 400', async () => {
    const { email, token } = await joined('expired')
    await service().from('waitlist').update({ confirm_sent_at: ago(7 * DAY + HOUR) }).eq('email', email)
    const wrong = await confirm('A'.repeat(43))
    const malformed = await confirm('not-a-token')
    const expired = await confirm(token)
    expect(wrong.status).toBe(400)
    expect(malformed).toEqual(wrong)
    expect(expired).toEqual(wrong)
    expect((await row(email))?.confirmed_at).toBeNull()
  })

  it('a malformed token never reaches the database', async () => {
    const db = new Proxy({}, { get: () => { throw new Error('database touched') } }) as ReturnType<typeof service>
    for (const token of ['', 'short', 'x'.repeat(44), 'has space'.padEnd(43, 'a'), 42, null]) {
      expect((await handleConfirm(db, { token })).status).toBe(400)
    }
    expect((await handleConfirm(db, null)).status).toBe(400)
  })

  it('emailed-but-unconfirmed addresses are forgotten after a week; never-emailed after 30 days; nothing else', async () => {
    const stale = address('purge-stale')
    const unsentWeek = address('purge-unsent-week')
    const unsentMonth = address('purge-unsent-month')
    const resent = address('purge-resent')
    const confirmed = address('purge-confirmed')
    const approvedOnly = address('purge-approved')
    const fresh = address('purge-fresh')
    const week = ago(8 * DAY)
    const seeded = await service().from('waitlist').insert([
      { email: stale, created_at: week, confirm_sent_at: week },
      // Held back by the cap or a failed send: never had the chance to confirm.
      { email: unsentWeek, created_at: week, confirm_sent_at: null },
      { email: unsentMonth, created_at: ago(31 * DAY), confirm_sent_at: null },
      { email: resent, created_at: week, confirm_sent_at: ago(DAY) },
      { email: confirmed, created_at: week, confirmed_at: week },
      { email: approvedOnly, created_at: week, approved_at: week },
      // One insert of several rows: each needs every column the others set.
      { email: fresh, created_at: new Date().toISOString() },
    ])
    expect(seeded.error).toBeNull()
    // Through a join, as in production.
    await handleJoinWaitlist(deps(recorder().sender), { email: address('purge-trigger') })
    expect(await row(stale)).toBeNull()
    expect(await row(unsentMonth)).toBeNull()
    for (const kept of [resent, confirmed, approvedOnly, fresh, unsentWeek]) expect(await row(kept), kept).not.toBeNull()
    await purgeUnconfirmed(service(), 7 * DAY, 30 * DAY) // and again is harmless
    expect(await row(resent)).not.toBeNull()
  })
})

describe.runIf(reachable)('the owner sees confirmed addresses only (VT-W12)', () => {
  it('lists the confirmed, counts the unconfirmed', async () => {
    const confirmed = address('list-confirmed')
    const unconfirmed = address('list-unconfirmed')
    await service().from('waitlist').insert([
      { email: confirmed, confirmed_at: new Date().toISOString() },
      { email: unconfirmed },
    ])
    const before = await listWaitlist(service())
    const emails = before.waiting.map((r) => r.email)
    expect(emails).toContain(confirmed)
    expect(emails).not.toContain(unconfirmed)
    expect(before.unconfirmedCount).toBeGreaterThanOrEqual(1)

    await service().from('waitlist').update({ confirmed_at: new Date().toISOString() }).eq('email', unconfirmed)
    const after = await listWaitlist(service())
    expect(after.waiting.map((r) => r.email)).toContain(unconfirmed)
    expect(after.unconfirmedCount).toBe(before.unconfirmedCount - 1)
  })

  it('approving vouches for the address: it is confirmed and its link retired', async () => {
    const email = address('approve')
    const { sent, sender } = recorder()
    await handleJoinWaitlist(deps(sender), { email })
    await approve(service(), email)
    const stored = await row(email)
    expect(stored?.approved_at).not.toBeNull()
    expect(stored?.confirmed_at).not.toBeNull()
    expect((await confirm(tokenIn(sent[0]!))).status).toBe(400)
  })

  it('an owner approving someone who never joined still works, and the invite still goes', async () => {
    const email = address('direct')
    const { sent, sender } = recorder()
    const res = await (await handleApprove({ service: service(), sender, origin: 'https://lastten.example' }, { email })).json()
    expect(res).toEqual({ approved: true, emailed: true, alreadyInvited: false })
    expect(sent[0]!.subject).toMatch(/is ready/)
    expect((await row(email))?.confirmed_at).not.toBeNull()
  })
})

describe.runIf(reachable)('a daily cap across all addresses (VT-W10)', () => {
  it('a burst of joins at once never sends past the cap (code review)', async () => {
    const { confirmEmailsSince } = await import('@/lib/waitlist/store')
    const already = await confirmEmailsSince(service(), new Date(Date.now() - DAY))
    const { sent, sender } = recorder()
    const burst = Array.from({ length: 8 }, (_, i) => address(`cap-burst-${i}`))
    await Promise.all(burst.map((email) => handleJoinWaitlist({ ...deps(sender), dailyCap: already + 2 }, { email })))
    expect(sent.length).toBeLessThanOrEqual(2)
    // The ones held back keep their row, with no claim left on it: joining tomorrow sends.
    const held = burst.filter((e) => !sent.some((m) => m.to === e))
    for (const email of held) expect((await row(email))?.confirm_sent_at, email).toBeNull()
  })

  it('past the cap nothing is sent, the address is kept, and the answer is the same', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const { confirmEmailsSince } = await import('@/lib/waitlist/store')
    const { sent, sender } = recorder()
    const under = address('cap-under')
    const over = address('cap-over')
    // The cap is set from a fresh count before each join, so other files' joins on the shared
    // database cannot shift it: room for exactly one more, then none.
    await handleJoinWaitlist({ ...deps(sender), dailyCap: (await confirmEmailsSince(service(), since)) + 1 }, { email: under })
    const res = await handleJoinWaitlist({ ...deps(sender), dailyCap: await confirmEmailsSince(service(), since) }, { email: over })
    expect(await res.json()).toEqual({ ok: true })
    expect(sent.map((m) => m.to)).toEqual([under])
    expect(await row(over)).not.toBeNull()
    expect((await row(over))?.confirm_sent_at).toBeNull()
  })
})
