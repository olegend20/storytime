import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureFamily } from '@/lib/family/service'
import { precheckGeneration } from '@/lib/generate/pipeline'
import { LimitsQuotaService } from '@/lib/generate/production-deps'
import { consumeCredit, creditBalance, grantCredits } from '@/lib/limits/credits'
import { preflight } from '@/lib/limits/guard'
import { consumeQuota, quotaStatus } from '@/lib/limits/quota'
import { quotaResponseFor } from '@/lib/limits/quota-response'
import { anon, applyTestSupabaseEnv, dbReachable, service, SKIP_REASON, TestWorld } from '../helpers/db'
import { cleanupUser, createTestUser, type TestUser } from './support/lane1-db'

/**
 * Issue #128: a family has a balance of stories, starting with three free ones. Against the
 * real `story_credit_grants` table and its two functions.
 */

applyTestSupabaseEnv()
const reachable = await dbReachable()
const world = new TestWorld()
const users: TestUser[] = []

const savedEnv = {
  credits: process.env.STORY_CREDITS_ENABLED,
  owner: process.env.OWNER_USER_ID,
}

function restore(name: 'STORY_CREDITS_ENABLED' | 'OWNER_USER_ID', value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(() => {
  // The kill switch and the budget cap must not get in the way of what is asserted here.
  process.env.GENERATION_ENABLED = 'true'
  process.env.DAILY_BUDGET_USD = '1000000'
})

beforeEach(() => {
  process.env.STORY_CREDITS_ENABLED = 'true'
  delete process.env.OWNER_USER_ID
})

afterEach(() => {
  restore('STORY_CREDITS_ENABLED', savedEnv.credits)
  restore('OWNER_USER_ID', savedEnv.owner)
})

afterAll(async () => {
  if (!reachable) return
  await world.cleanup()
  for (const u of users) await cleanupUser(u)
})

if (!reachable) console.warn(`[skip] test/int/story-credits.test.ts - ${SKIP_REASON}`)

async function grantsOf(familyId: string) {
  const { data, error } = await service()
    .from('story_credit_grants')
    .select('amount, remaining, reason, expires_at, source_ref')
    .eq('family_id', familyId)
    .order('created_at')
  if (error) throw new Error(error.message)
  return data ?? []
}

/** Empty the three free stories, so a test can set up exactly the grants it is about. */
async function emptyTrial(familyId: string) {
  const { error } = await service()
    .from('story_credit_grants')
    .update({ remaining: 0 })
    .eq('family_id', familyId)
    .eq('reason', 'trial')
  if (error) throw new Error(error.message)
}

const BODY = {
  child_ids: ['11111111-1111-4111-8111-111111111111'],
  topic_input: 'how volcanoes work',
  tones: ['funny'],
  length_minutes: 10,
}

describe.runIf(reachable)('issue #128: a balance of stories', () => {
  it('VT-CR1: a new family has one grant of 3, reason trial, with no expiry', async () => {
    const family = await world.createFamily({ label: 'cr1' })
    expect(await grantsOf(family.familyId)).toEqual([
      { amount: 3, remaining: 3, reason: 'trial', expires_at: null, source_ref: `trial:${family.familyId}` },
    ])
    expect(await creditBalance(family.familyId)).toBe(3)

    // The same holds when the parent's own session creates the family, as sign-in does:
    // that session cannot write a grant itself, so the database does it.
    const user = await createTestUser('cr1-self')
    users.push(user)
    const own = await ensureFamily(user.client, user.userId)
    expect(await creditBalance(own.id)).toBe(3)
  })

  it('VT-CR2: a saved story lowers the balance by one; a failed or refused story leaves it unchanged', async () => {
    const family = await world.createFamily({ label: 'cr2' })

    // Every request, saved or not, runs these; a refused or failed one runs nothing else.
    await preflight({ familyId: family.familyId })
    await quotaStatus({ familyId: family.familyId })
    await new LimitsQuotaService().preflight(family.familyId)
    expect(await creditBalance(family.familyId)).toBe(3)

    // What the pipeline calls once the story row is saved.
    const saved = await consumeQuota({ familyId: family.familyId })
    expect(saved.credits).toEqual({ taken: true, balance: 2 })
    expect(await creditBalance(family.familyId)).toBe(2)
    // The daily counter moved too: the balance sits beside the daily limit, not instead of it.
    expect(saved.used).toBe(1)
  })

  it('VT-CR3: two stories saved at once against a balance of 1 leave it at 0, never below', async () => {
    const family = await world.createFamily({ label: 'cr3' })
    await consumeCredit(family.familyId)
    await consumeCredit(family.familyId)
    expect(await creditBalance(family.familyId)).toBe(1)

    const results = await Promise.all([
      consumeCredit(family.familyId),
      consumeCredit(family.familyId),
      consumeCredit(family.familyId),
    ])
    expect(results.filter((r) => r.taken)).toHaveLength(1)
    expect(await creditBalance(family.familyId)).toBe(0)
    const rows = await grantsOf(family.familyId)
    expect(rows.every((g) => g.remaining >= 0)).toBe(true)
  })

  it('VT-CR4: stories come from the grant that expires soonest; an expired grant counts for nothing', async () => {
    const family = await world.createFamily({ label: 'cr4' })
    await emptyTrial(family.familyId)
    const day = 24 * 60 * 60 * 1000
    const ref = (name: string) => `test:${world.tag}:cr4:${name}`

    await grantCredits({ familyId: family.familyId, amount: 10, reason: 'top_up', sourceRef: ref('pack') })
    await grantCredits({
      familyId: family.familyId,
      amount: 12,
      reason: 'subscription',
      sourceRef: ref('later'),
      expiresAt: new Date(Date.now() + 40 * day),
    })
    await grantCredits({
      familyId: family.familyId,
      amount: 12,
      reason: 'subscription',
      sourceRef: ref('sooner'),
      expiresAt: new Date(Date.now() + 5 * day),
    })
    const expired = await grantCredits({
      familyId: family.familyId,
      amount: 30,
      reason: 'subscription',
      sourceRef: ref('expired'),
      expiresAt: new Date(Date.now() - day),
    })
    // 10 + 12 + 12: the expired 30 are not in the balance, in the database or in the app.
    expect(expired.balance).toBe(34)
    expect(await creditBalance(family.familyId)).toBe(34)

    const taken = await consumeCredit(family.familyId)
    expect(taken).toEqual({ taken: true, balance: 33 })
    const remaining = Object.fromEntries((await grantsOf(family.familyId)).map((g) => [g.source_ref, g.remaining]))
    expect(remaining[ref('sooner')]).toBe(11)
    expect(remaining[ref('later')]).toBe(12)
    expect(remaining[ref('pack')]).toBe(10)
    expect(remaining[ref('expired')]).toBe(30)

    // A pack that never expires is used last: only once the dated grants are empty.
    await service()
      .from('story_credit_grants')
      .update({ remaining: 0 })
      .in('source_ref', [ref('sooner'), ref('later')])
    await consumeCredit(family.familyId)
    const after = Object.fromEntries((await grantsOf(family.familyId)).map((g) => [g.source_ref, g.remaining]))
    expect(after[ref('pack')]).toBe(9)
  })

  it('VT-CR5: granting twice with the same source_ref adds stories once', async () => {
    const family = await world.createFamily({ label: 'cr5' })
    const sourceRef = `test:${world.tag}:cr5:invoice`

    const first = await grantCredits({ familyId: family.familyId, amount: 12, reason: 'subscription', sourceRef })
    const second = await grantCredits({ familyId: family.familyId, amount: 12, reason: 'subscription', sourceRef })
    expect(first).toEqual({ granted: true, balance: 15 })
    expect(second).toEqual({ granted: false, balance: 15 })
    expect(await grantsOf(family.familyId)).toHaveLength(2)
  })

  it('VT-CR6: a family reads its own grants and nobody else\'s, and cannot write any', async () => {
    const mine = await createTestUser('cr6-mine')
    const theirs = await createTestUser('cr6-theirs')
    users.push(mine, theirs)
    const myFamily = await ensureFamily(mine.client, mine.userId)
    const theirFamily = await ensureFamily(theirs.client, theirs.userId)

    const seen = await mine.client.from('story_credit_grants').select('family_id, remaining')
    expect(seen.error).toBeNull()
    expect(seen.data).toEqual([{ family_id: myFamily.id, remaining: 3 }])

    // No write of any kind, on their own family or another's.
    const insert = await mine.client.from('story_credit_grants').insert({
      family_id: myFamily.id,
      amount: 100,
      remaining: 100,
      reason: 'adjustment',
      source_ref: `test:${world.tag}:cr6:self-grant`,
    })
    expect(insert.error).not.toBeNull()
    await mine.client.from('story_credit_grants').update({ remaining: 100 }).eq('family_id', myFamily.id)
    await mine.client.from('story_credit_grants').delete().eq('family_id', theirFamily.id)
    const grantRpc = await mine.client.rpc('grant_story_credits', {
      p_family_id: myFamily.id,
      p_amount: 100,
      p_reason: 'adjustment',
      p_source_ref: `test:${world.tag}:cr6:rpc`,
    })
    expect(grantRpc.error).not.toBeNull()
    const consumeRpc = await mine.client.rpc('consume_story_credit', { p_family_id: theirFamily.id })
    expect(consumeRpc.error).not.toBeNull()
    const balanceRpc = await mine.client.rpc('story_credit_balance', { p_family_id: theirFamily.id })
    expect(balanceRpc.error).not.toBeNull()

    expect(await creditBalance(myFamily.id)).toBe(3)
    expect(await creditBalance(theirFamily.id)).toBe(3)
    expect(await grantsOf(myFamily.id)).toHaveLength(1)

    // Signed out: nothing at all.
    const signedOut = await anon().from('story_credit_grants').select('id')
    expect(signedOut.data ?? []).toEqual([])
  })

  it('VT-CR7: at balance 0, preflight returns out_of_stories before any model call', async () => {
    const family = await world.createFamily({ label: 'cr7' })
    await emptyTrial(family.familyId)

    const gate = await preflight({ familyId: family.familyId })
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.status).toBe(402)
    expect(gate.body.code).toBe('out_of_stories')
    expect(gate.body.quota_consumed).toBe(false)
    // Not a daily limit: there is no time at which it comes back by itself.
    expect(gate.body.resets_at).toBeNull()

    // The route's free check answers the same, with the parent-facing copy. It runs before
    // the stream opens and before the first model call (the stub input guard is never reached).
    const pre = await precheckGeneration(family.familyId, BODY, { quota: new LimitsQuotaService() })
    expect(pre.ok).toBe(false)
    if (pre.ok) return
    expect(pre.status).toBe(402)
    expect(pre.error.code).toBe('out_of_stories')
    expect(pre.error.message).toBe("You've used your free stories. More are coming soon.")

    // And the page is told the balance, so it can disable the button without asking to start.
    const shown = await quotaResponseFor({ id: family.familyId, timezone: family.timezone })
    expect(shown.credits).toEqual({ balance: 0 })

    // With stories left, the same family is let through and told how many.
    await grantCredits({
      familyId: family.familyId,
      amount: 2,
      reason: 'adjustment',
      sourceRef: `test:${world.tag}:cr7:gift`,
    })
    const open = await preflight({ familyId: family.familyId })
    expect(open.ok).toBe(true)
    if (open.ok) expect(open.credits).toEqual({ balance: 2 })
  })

  it('VT-CR8: with the switch off, nothing reads or moves the balance', async () => {
    for (const off of [undefined, 'false', '0', '', 'yes please']) {
      restore('STORY_CREDITS_ENABLED', off)
      const family = await world.createFamily({ label: 'cr8' })
      await emptyTrial(family.familyId)
      await grantCredits({
        familyId: family.familyId,
        amount: 1,
        reason: 'adjustment',
        sourceRef: `test:${world.tag}:cr8:${family.familyId}`,
      })

      // An empty balance would not stop this family; here it has 1 and makes 3 stories.
      const gate = await preflight({ familyId: family.familyId })
      expect(gate.ok, `STORY_CREDITS_ENABLED=${String(off)}`).toBe(true)
      if (gate.ok) expect(gate.credits).toBeNull()

      for (let i = 1; i <= 3; i += 1) {
        const saved = await consumeQuota({ familyId: family.familyId })
        expect(saved.allowed).toBe(true)
        expect(saved.used).toBe(i)
        expect(saved.credits).toBeUndefined()
      }
      expect(await creditBalance(family.familyId)).toBe(1)

      const fourth = await preflight({ familyId: family.familyId })
      expect(fourth.ok).toBe(false)
      if (!fourth.ok) expect(fourth.body.code).toBe('quota_exceeded')

      const shown = await quotaResponseFor({ id: family.familyId, timezone: family.timezone })
      expect(shown).toEqual({
        used: 3,
        limit: 3,
        resets_at: expect.any(String),
        generation_enabled: true,
      })
    }
  })

  it('VT-CR9: the owner\'s family is still unlimited', async () => {
    const family = await world.createFamily({ label: 'cr9' })
    await emptyTrial(family.familyId)
    process.env.OWNER_USER_ID = family.userId

    const gate = await preflight({ familyId: family.familyId })
    expect(gate.ok).toBe(true)
    if (gate.ok) {
      expect(gate.quota.unlimited).toBe(true)
      expect(gate.credits).toBeNull()
    }
    const saved = await consumeQuota({ familyId: family.familyId })
    expect(saved.allowed).toBe(true)
    expect(saved.credits).toBeUndefined()
    const shown = await quotaResponseFor({ id: family.familyId, timezone: family.timezone })
    expect(shown.unlimited).toBe(true)
    expect(shown.credits).toBeUndefined()

    // Somebody else, same moment: the balance applies.
    const parent = await world.createFamily({ label: 'cr9-parent' })
    await emptyTrial(parent.familyId)
    const blocked = await preflight({ familyId: parent.familyId })
    expect(blocked.ok).toBe(false)
  })

  it('a saved story is still reported as saved when taking it from the balance fails', async () => {
    const family = await world.createFamily({ label: 'credit-fails' })
    const real = service()
    // The database answers everything except the one call that takes a story.
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'rpc') {
          return (fn: string, args: unknown) =>
            fn === 'consume_story_credit'
              ? Promise.resolve({ data: null, error: { message: 'simulated outage' } })
              : target.rpc(fn, args as Record<string, unknown>)
        }
        const value = Reflect.get(target, prop, receiver) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    })

    const logged: unknown[] = []
    const original = console.error
    console.error = (...a: unknown[]) => void logged.push(a.join(' '))
    try {
      // Does not throw: the pipeline would turn a throw here into "we couldn't make a story",
      // with a retry button, for a story that is already in the library.
      const saved = await consumeQuota({ familyId: family.familyId, client: flaky })
      expect(saved.allowed).toBe(true)
      expect(saved.used).toBe(1)
      expect(saved.credits).toBeUndefined()
    } finally {
      console.error = original
    }
    expect(String(logged[0])).toMatch(/was not taken from family .* balance: .*simulated outage/)
    expect(await creditBalance(family.familyId)).toBe(3)
  })

  it('the daily limit still applies on top of a balance', async () => {
    const family = await world.createFamily({ label: 'daily' })
    await grantCredits({
      familyId: family.familyId,
      amount: 10,
      reason: 'adjustment',
      sourceRef: `test:${world.tag}:daily`,
    })
    for (let i = 0; i < 3; i += 1) await consumeQuota({ familyId: family.familyId })

    expect(await creditBalance(family.familyId)).toBe(10)
    const gate = await preflight({ familyId: family.familyId })
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.status).toBe(429)
      expect(gate.body.code).toBe('quota_exceeded')
    }
  })
})
