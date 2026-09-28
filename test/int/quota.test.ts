import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, dbReachable, service, SKIP_REASON, TestWorld, applyTestSupabaseEnv } from '../helpers/db'
import { consumeQuota, quotaStatus } from '@/lib/limits/quota'
import { preflight } from '@/lib/limits/guard'
import { usageDateFor } from '@/lib/limits/timezone'
import { DAILY_STORY_LIMIT } from '@/lib/schemas/api'

/**
 * F8 integration VTs for the daily quota, against the real `daily_usage` table and the real
 * `consume_daily_quota` function.
 */

applyTestSupabaseEnv()
const reachable = await dbReachable()
const world = new TestWorld()

beforeAll(() => {
  // Budget cap and kill switch must not interfere with the quota assertions.
  process.env.GENERATION_ENABLED = 'true'
  process.env.DAILY_BUDGET_USD = '1000000'
})

afterAll(async () => {
  if (reachable) await world.cleanup()
})

if (!reachable) console.warn(`[skip] test/int/quota.test.ts - ${SKIP_REASON}`)

describe.runIf(reachable)('F8 daily quota', () => {
  /** VT: 3 successful generations then a 4th → 429; daily_usage.count === 3. */
  it('allows three stories a day and refuses the fourth with 429', async () => {
    const family = await world.createFamily({ timezone: 'Europe/London', label: 'quota' })
    const at = new Date('2026-06-15T19:00:00Z')

    for (let i = 1; i <= DAILY_STORY_LIMIT; i += 1) {
      const result = await consumeQuota({ familyId: family.familyId, timezone: family.timezone, at })
      expect(result.allowed, `story ${i}`).toBe(true)
      expect(result.used, `story ${i}`).toBe(i)
      expect(result.remaining, `story ${i}`).toBe(DAILY_STORY_LIMIT - i)
    }

    const fourth = await consumeQuota({ familyId: family.familyId, timezone: family.timezone, at })
    expect(fourth.allowed).toBe(false)
    // The refused attempt must not have moved the counter.
    expect(fourth.used).toBe(3)

    const { data } = await service()
      .from('daily_usage')
      .select('count, usage_date')
      .eq('family_id', family.familyId)
      .eq('usage_date', usageDateFor(family.timezone, at))
      .single()
    expect(data?.count).toBe(3)

    // And the request-level gate returns the status + copy the API contract promises.
    const gate = await preflight({ familyId: family.familyId, timezone: family.timezone, at })
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.status).toBe(429)
    expect(gate.body.code).toBe('quota_exceeded')
    expect(gate.body.quota_consumed).toBe(false)
    // "429 with the local reset time" (F8 AC): next midnight in Europe/London, BST in June.
    expect(gate.body.resets_at).toBe('2026-06-15T23:00:00.000Z')
  })

  /**
   * VT: a family in Pacific/Auckland at 23:30 local and one in America/Los_Angeles get
   * different `usage_date`s for the same UTC instant.
   *
   * 2026-03-10T11:30:00Z is 00:30 on the 11th in Auckland and 04:30 on the 10th in LA.
   */
  it('buckets the same UTC instant into different usage_dates per family timezone', async () => {
    const auckland = await world.createFamily({ timezone: 'Pacific/Auckland', label: 'akl' })
    const la = await world.createFamily({ timezone: 'America/Los_Angeles', label: 'lax' })
    const instant = new Date('2026-03-10T11:30:00Z')

    const a = await consumeQuota({ familyId: auckland.familyId, timezone: auckland.timezone, at: instant })
    const l = await consumeQuota({ familyId: la.familyId, timezone: la.timezone, at: instant })

    expect(a.allowed).toBe(true)
    expect(l.allowed).toBe(true)
    expect(a.usageDate).toBe('2026-03-11')
    expect(l.usageDate).toBe('2026-03-10')
    expect(a.usageDate).not.toBe(l.usageDate)

    // The rows in the database carry those dates, not the UTC one.
    const { data } = await service()
      .from('daily_usage')
      .select('family_id, usage_date, count')
      .in('family_id', [auckland.familyId, la.familyId])
    const dates = new Map((data ?? []).map((r) => [r.family_id as string, r.usage_date as string]))
    expect(dates.get(auckland.familyId)).toBe('2026-03-11')
    expect(dates.get(la.familyId)).toBe('2026-03-10')

    // Reset times differ too: Auckland has nearly a full day left, LA about 19.5 hours.
    expect(a.resetsAt).not.toBe(l.resetsAt)
  })

  /** The family's OWN midnight, not the server's: 23:30 local is still today. */
  it('keeps 23:30 and 00:30 local on opposite sides of the boundary', async () => {
    const family = await world.createFamily({ timezone: 'Pacific/Auckland', label: 'boundary' })
    // 2026-03-10T10:30:00Z = 23:30 on the 10th; 2026-03-10T11:30:00Z = 00:30 on the 11th.
    const before = await consumeQuota({
      familyId: family.familyId,
      timezone: family.timezone,
      at: new Date('2026-03-10T10:30:00Z'),
    })
    const after = await consumeQuota({
      familyId: family.familyId,
      timezone: family.timezone,
      at: new Date('2026-03-10T11:30:00Z'),
    })
    expect(before.usageDate).toBe('2026-03-10')
    expect(after.usageDate).toBe('2026-03-11')
    // Each local day starts the count again.
    expect(before.used).toBe(1)
    expect(after.used).toBe(1)
  })

  /** F8 AC: quota is consumed only on a successful stories insert — reads are free. */
  it('never moves the counter from a read', async () => {
    const family = await world.createFamily({ label: 'readonly' })
    const at = new Date('2026-07-01T12:00:00Z')

    for (let i = 0; i < 5; i += 1) {
      const snapshot = await quotaStatus({ familyId: family.familyId, timezone: family.timezone, at })
      expect(snapshot.used).toBe(0)
      expect(snapshot.remaining).toBe(DAILY_STORY_LIMIT)
      const gate = await preflight({ familyId: family.familyId, timezone: family.timezone, at })
      expect(gate.ok).toBe(true)
    }

    const { data } = await service()
      .from('daily_usage')
      .select('count')
      .eq('family_id', family.familyId)
      .eq('usage_date', '2026-07-01')
      .maybeSingle()
    expect(data).toBeNull()
  })

  /**
   * The increment is a single `insert ... on conflict ... where count < limit`, so two
   * requests racing at count = 2 cannot both become 3. Without that, a double-tap on
   * "Start the story" is a free fourth story.
   */
  it('lets exactly three of six concurrent claims through', async () => {
    const family = await world.createFamily({ label: 'race' })
    const at = new Date('2026-08-09T09:00:00Z')

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        consumeQuota({ familyId: family.familyId, timezone: family.timezone, at }),
      ),
    )
    expect(results.filter((r) => r.allowed)).toHaveLength(DAILY_STORY_LIMIT)

    const { data } = await service()
      .from('daily_usage')
      .select('count')
      .eq('family_id', family.familyId)
      .eq('usage_date', '2026-08-09')
      .single()
    expect(data?.count).toBe(DAILY_STORY_LIMIT)
  })

  it('reads the family timezone from the families row when it is not passed in', async () => {
    const family = await world.createFamily({ timezone: 'Pacific/Auckland', label: 'lookup' })
    const snapshot = await quotaStatus({ familyId: family.familyId, at: new Date('2026-03-10T11:30:00Z') })
    expect(snapshot.timezone).toBe('Pacific/Auckland')
    expect(snapshot.usageDate).toBe('2026-03-11')
  })

  /**
   * A client must not be able to reset its own quota. `daily_usage` is select-only for the
   * family and `consume_daily_quota` is revoked from anon/authenticated.
   */
  it('refuses quota writes and quota RPC calls from a client key', async () => {
    const family = await world.createFamily({ label: 'rls' })
    await consumeQuota({ familyId: family.familyId, timezone: family.timezone, at: new Date('2026-09-01T10:00:00Z') })

    const client = anon()
    const insert = await client
      .from('daily_usage')
      .insert({ family_id: family.familyId, usage_date: '2026-09-01', count: 0 })
    expect(insert.error, 'anon must not insert daily_usage').not.toBeNull()

    const update = await client
      .from('daily_usage')
      .update({ count: 0 })
      .eq('family_id', family.familyId)
    // No update policy exists, so this affects zero rows even where it does not error.
    const { data: still } = await service()
      .from('daily_usage')
      .select('count')
      .eq('family_id', family.familyId)
      .eq('usage_date', '2026-09-01')
      .single()
    expect(still?.count, `anon update returned ${JSON.stringify(update.error)}`).toBe(1)

    const rpc = await client.rpc('consume_daily_quota', {
      p_family_id: family.familyId,
      p_usage_date: '2026-09-01',
      p_limit: 99,
    })
    expect(rpc.error, 'anon must not execute consume_daily_quota').not.toBeNull()
  })
})
