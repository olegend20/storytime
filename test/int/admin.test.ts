import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { anon, dbReachable, service, SKIP_REASON, TestWorld, applyTestSupabaseEnv } from '../helpers/db'

/**
 * F12 integration VTs.
 *
 * The page's auth lookup is stubbed (there is no HTTP request in a vitest run, so
 * `next/headers` has no cookie store) but everything else is real: the real gate, the real
 * `notFound()`, the real service-role client and the real SQL views.
 */

const session = vi.hoisted(() => ({ userId: null as string | null }))

vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }) },
  }),
}))

const AdminPage = (await import('@/app/admin/page')).default
const { isOwner, requireOwner } = await import('@/lib/admin/gate')
const { loadAdminMetrics } = await import('@/lib/admin/metrics')

applyTestSupabaseEnv()
const reachable = await dbReachable()
const world = new TestWorld()

/**
 * A day nothing else in the repo seeds, so the view-arithmetic assertions are exact. The
 * test asserts it owns the day and names the collision if it ever does not.
 */
const SEED_DAY = '2012-02-29'
const SEED_AT = `${SEED_DAY}T12:00:00Z`

const savedOwner = process.env.OWNER_USER_ID
let db: SupabaseClient

beforeAll(() => {
  db = service()
})

afterEach(() => {
  session.userId = null
  if (savedOwner === undefined) delete process.env.OWNER_USER_ID
  else process.env.OWNER_USER_ID = savedOwner
})

afterAll(async () => {
  if (reachable) await world.cleanup()
})

function is404(err: unknown): boolean {
  const digest = (err as { digest?: string })?.digest ?? (err as Error)?.message ?? ''
  return /404|NEXT_NOT_FOUND/.test(String(digest))
}

if (!reachable) console.warn(`[skip] test/int/admin.test.ts - ${SKIP_REASON}`)

describe.runIf(reachable)('F12 /admin owner gate', () => {
  /** VT: non-owner user → 404; owner → 200. */
  it('404s for a signed-in non-owner and renders for the owner', async () => {
    const owner = await world.createFamily({ label: 'owner' })
    const parent = await world.createFamily({ label: 'parent' })
    process.env.OWNER_USER_ID = owner.userId

    session.userId = parent.userId
    await expect(AdminPage()).rejects.toSatisfy(is404, 'a non-owner must get a 404, not a 403')

    session.userId = owner.userId
    const rendered = await AdminPage()
    expect(rendered).toBeTruthy()
    // A React element, i.e. the page would render 200.
    expect((rendered as { type?: unknown }).type).toBeTruthy()
  })

  it('404s for an anonymous visitor', async () => {
    const owner = await world.createFamily({ label: 'owner-anon' })
    process.env.OWNER_USER_ID = owner.userId
    session.userId = null
    await expect(AdminPage()).rejects.toSatisfy(is404)
  })

  /**
   * Fails closed: an unset OWNER_USER_ID must not open the dashboard to whoever is signed in.
   */
  it('404s for everyone when OWNER_USER_ID is unset', async () => {
    const someone = await world.createFamily({ label: 'no-owner' })
    delete process.env.OWNER_USER_ID
    session.userId = someone.userId
    expect(isOwner(someone.userId)).toBe(false)
    await expect(requireOwner()).rejects.toSatisfy(is404)
  })

  it('never leaks that the page exists: the failure is a 404, never a 403', async () => {
    const owner = await world.createFamily({ label: 'owner-403' })
    const parent = await world.createFamily({ label: 'parent-403' })
    process.env.OWNER_USER_ID = owner.userId
    session.userId = parent.userId

    const err = await AdminPage().then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).not.toBeNull()
    expect(String((err as { digest?: string }).digest ?? (err as Error).message)).not.toMatch(/403|forbidden/i)
    expect(is404(err)).toBe(true)
  })
})

describe.runIf(reachable)('F12 numbers come from SQL views', () => {
  /** VT: v_daily_costs sums to the same total as a direct sum(cost_usd) for a seeded day. */
  it('v_daily_costs matches a direct sum over generation_logs for a seeded day', async () => {
    const family = await world.createFamily({ label: 'viewsum' })
    const costs = [0.0538, 0.01, 0.007, 0.00055, 0.123456]
    for (const costUsd of costs) {
      await world.insertLog({ familyId: family.familyId, costUsd, createdAt: SEED_AT })
    }

    // Direct sum straight off the table, the same way a human would check the bill.
    const { data: rows, error } = await db
      .from('generation_logs')
      .select('cost_usd')
      .gte('created_at', `${SEED_DAY}T00:00:00Z`)
      .lt('created_at', '2012-03-01T00:00:00Z')
    expect(error).toBeNull()
    const direct = (rows ?? []).reduce((sum, r) => sum + Number(r.cost_usd), 0)

    const { data: view } = await db
      .from('v_daily_costs')
      .select('day, calls, cost_usd')
      .eq('day', SEED_DAY)
      .single()

    expect(Number(view?.cost_usd)).toBeCloseTo(direct, 6)
    expect(Number(view?.cost_usd)).toBeCloseTo(costs.reduce((a, b) => a + b, 0), 6)
    expect(view?.calls).toBe(rows?.length)
  })

  /** VT: seeded 10 stories with 8 fact-pack hits → dashboard shows 80% hit rate. */
  it('reports an 80% fact-pack hit rate for 10 stories with 8 hits', async () => {
    const family = await world.createFamily({ label: 'hitrate' })
    const seriesId = await world.createSeries(family.familyId)
    // Packs built the day before the stories, so reusing one counts as a hit.
    const packA = await world.createFactPack({ createdAt: '2012-02-28T09:00:00Z', label: 'a' })
    const packB = await world.createFactPack({ createdAt: '2012-02-28T10:00:00Z', label: 'b' })

    const mine: string[] = []
    for (let i = 0; i < 8; i += 1) {
      mine.push(
        await world.createStory({
          familyId: family.familyId,
          seriesId,
          factPackId: i % 2 === 0 ? packA : packB,
          createdAt: SEED_AT,
        }),
      )
    }
    for (let i = 0; i < 2; i += 1) {
      mine.push(
        await world.createStory({ familyId: family.familyId, seriesId, factPackId: null, createdAt: SEED_AT }),
      )
    }

    // The shared database means another lane could seed the same day. Say so loudly rather
    // than quietly asserting the wrong denominator.
    const { data: onDay } = await db
      .from('stories')
      .select('id')
      .gte('created_at', `${SEED_DAY}T00:00:00Z`)
      .lt('created_at', '2012-03-01T00:00:00Z')
    expect(
      (onDay ?? []).length,
      `another lane seeded stories on ${SEED_DAY}; pick a different marker day`,
    ).toBe(mine.length)

    const { data: row } = await db
      .from('v_fact_pack_hit_rate_daily')
      .select('day, stories, hits, hit_rate')
      .eq('day', SEED_DAY)
      .single()

    expect(row?.stories).toBe(10)
    expect(row?.hits).toBe(8)
    expect(Number(row?.hit_rate)).toBeCloseTo(0.8, 6)
  })

  it('loads every dashboard panel from a view, with no read errors', async () => {
    const metrics = await loadAdminMetrics(db)
    expect(metrics.errors, metrics.errors.join('; ')).toEqual([])

    // Read-only controls are surfaced, not settable from the page.
    expect(typeof metrics.controls.generationEnabled).toBe('boolean')
    expect(metrics.controls.dailyStoryLimit).toBe(3)
    expect(metrics.controls.writerModel).toBeTruthy()

    // Every headline the F12 scope names has a defined (possibly null) slot.
    expect(metrics.cost).toHaveProperty('medianCostUsd')
    expect(metrics.cost).toHaveProperty('p95CostUsd')
    expect(metrics.cost).toHaveProperty('writeCacheReadRatio')
    expect(metrics.factPacks).toHaveProperty('hitRate')
    expect(metrics.stories).toHaveProperty('flaggedRate')
    expect(metrics.budget).toHaveProperty('remainingUsd')
    expect(Array.isArray(metrics.latency)).toBe(true)
    expect(Array.isArray(metrics.topTopics)).toBe(true)
    expect(Array.isArray(metrics.byWriter)).toBe(true)
    expect(Array.isArray(metrics.recent)).toBe(true)
  })

  /**
   * Per-story cost and the median must come from the writing model actually logged, never
   * from a word-count estimate: Haiku 4.5's tokenizer is ~30% shorter than the others', so a
   * text-derived comparison would flatter it.
   */
  it('attributes cost per story to the writing model from generation_logs', async () => {
    const family = await world.createFamily({ label: 'writer-attr' })
    const seriesId = await world.createSeries(family.familyId)
    const storyId = await world.createStory({ familyId: family.familyId, seriesId, createdAt: SEED_AT })

    // A story's cost is the sum of every log row carrying its id, across models.
    await world.insertLog({
      familyId: family.familyId,
      storyId,
      purpose: 'write',
      model: 'claude-sonnet-5',
      costUsd: 0.0538,
      createdAt: SEED_AT,
      inputTokens: 1_500,
      cacheReadTokens: 4_000,
      outputTokens: 5_000,
    })
    await world.insertLog({
      familyId: family.familyId,
      storyId,
      purpose: 'quality',
      model: 'claude-haiku-4-5-20251001',
      costUsd: 0.007,
      createdAt: SEED_AT,
    })

    const { data: cost } = await db
      .from('v_story_costs')
      .select('story_id, cost_usd')
      .eq('story_id', storyId)
      .single()
    expect(Number(cost?.cost_usd)).toBeCloseTo(0.0608, 6)

    const { data: writer } = await db
      .from('v_story_writer')
      .select('story_id, writer_model')
      .eq('story_id', storyId)
      .single()
    // The write call, not the cheaper helper call on the same story.
    expect(writer?.writer_model).toBe('claude-sonnet-5')
  })

  it('keeps every cost view out of reach of a client key', async () => {
    const client = anon()
    for (const view of [
      'v_daily_costs',
      'v_daily_stories',
      'v_story_costs',
      'v_cost_summary',
      'v_story_cost_summary',
      'v_story_cost_by_writer',
      'v_story_health',
      'v_latency_summary',
      'v_fact_pack_hit_rate',
      'v_fact_pack_hit_rate_daily',
      'v_budget_today',
    ]) {
      const { error } = await client.from(view).select('*').limit(1)
      expect(error?.message, `${view} must not be readable with the anon key`).toMatch(/permission denied/i)
    }
  })
})
