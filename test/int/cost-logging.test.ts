import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { anon, dbReachable, service, SKIP_REASON, TestWorld, applyTestSupabaseEnv } from '../helpers/db'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * F8 integration VTs for cost logging, the kill switch and the daily budget cap.
 *
 * The Anthropic SDK is replaced with a stub so `callModel()` takes its LIVE path — the
 * failure VT ("a failed generation still writes a log row with ok=false") only exists on that
 * path — while never touching the network. `LIVE_API` is set per test and restored after.
 */

const behaviour = vi.hoisted(() => ({
  mode: 'success' as 'success' | 'fail',
  usage: {
    input_tokens: 1_500,
    cache_read_input_tokens: 4_000,
    cache_creation_input_tokens: 0,
    output_tokens: 5_000,
  },
}))

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
  class StubAnthropic {
    messages = {
      create: async () => {
        if (behaviour.mode === 'fail') {
          // What a dropped connection / fixture timeout looks like to the wrapper.
          throw new actual.APIConnectionError({ message: 'simulated fixture timeout' })
        }
        return {
          id: 'msg_stub',
          content: [{ type: 'text', text: 'Once upon a time.' }],
          stop_reason: 'end_turn',
          usage: behaviour.usage,
        }
      },
    }
  }
  return { ...actual, default: StubAnthropic }
})

const { callModel } = await import('@/lib/ai/callModel')
const { ModelCallError } = await import('@/lib/ai/types')
const { SupabaseLogSink } = await import('@/lib/costs/sink')
const { budgetStatus } = await import('@/lib/costs/budget')
const { preflight, generationAvailable } = await import('@/lib/limits/guard')
const { computeCost } = await import('@/lib/ai/pricing')

applyTestSupabaseEnv()
const reachable = await dbReachable()
const world = new TestWorld()

const savedEnv = { ...process.env }
let db: SupabaseClient

beforeAll(() => {
  db = service()
  process.env.GENERATION_ENABLED = 'true'
  process.env.DAILY_BUDGET_USD = '1000000'
})

afterEach(() => {
  behaviour.mode = 'success'
  process.env.LIVE_API = savedEnv.LIVE_API
  if (savedEnv.LIVE_API === undefined) delete process.env.LIVE_API
  process.env.GENERATION_ENABLED = 'true'
  process.env.DAILY_BUDGET_USD = '1000000'
})

afterAll(async () => {
  if (reachable) await world.cleanup()
})

/** Collect and track every log row a test caused, so cleanup is exact. */
async function logsFor(familyId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await db
    .from('generation_logs')
    .select('id, purpose, model, ok, error, cost_usd, input_tokens, cache_read_tokens, output_tokens, latency_ms')
    .eq('family_id', familyId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Record<string, unknown>[]
  world.trackLogIds(rows.map((r) => r.id as string))
  return rows
}

if (!reachable) console.warn(`[skip] test/int/cost-logging.test.ts - ${SKIP_REASON}`)

describe.runIf(reachable)('F8 Supabase generation log sink', () => {
  it('writes a row with a non-null cost for a successful call', async () => {
    const family = await world.createFamily({ label: 'log-ok' })
    process.env.LIVE_API = '1'

    const sink = new SupabaseLogSink(db)
    const result = await callModel({
      purpose: 'write',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'tell me a story' }],
      familyId: family.familyId,
      sink,
    })

    expect(sink.failedWrites, sink.lastError ?? '').toBe(0)
    const rows = await logsFor(family.familyId)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.ok).toBe(true)
    expect(row.purpose).toBe('write')
    expect(row.model).toBe('claude-sonnet-5')
    expect(row.cost_usd).not.toBeNull()
    expect(Number(row.cost_usd)).toBeGreaterThan(0)
    // The row's cost is what computeCost says for those tokens, to the 6dp the column holds.
    expect(Number(row.cost_usd)).toBeCloseTo(
      computeCost({ model: 'claude-sonnet-5', input: 1_500, cacheRead: 4_000, output: 5_000 }),
      6,
    )
    expect(Number(row.cost_usd)).toBeCloseTo(result.costUsd, 6)
    expect(row.input_tokens).toBe(1_500)
    expect(row.cache_read_tokens).toBe(4_000)
    expect(row.output_tokens).toBe(5_000)
  })

  /** VT: failed generation (fixture timeout) still writes a log row with `ok=false`. */
  it('writes an ok=false row for every failed attempt, with a non-null cost', async () => {
    const family = await world.createFamily({ label: 'log-fail' })
    process.env.LIVE_API = '1'
    behaviour.mode = 'fail'

    const sink = new SupabaseLogSink(db)
    await expect(
      callModel({
        purpose: 'write',
        model: 'claude-sonnet-5',
        messages: [{ role: 'user', content: 'tell me a story' }],
        familyId: family.familyId,
        // One retry, so we also prove EVERY attempt is logged, not just the last.
        maxRetries: 1,
        sink,
      }),
    ).rejects.toBeInstanceOf(ModelCallError)

    expect(sink.failedWrites, sink.lastError ?? '').toBe(0)
    const rows = await logsFor(family.familyId)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.ok).toBe(false)
      expect(row.error).toMatch(/simulated fixture timeout/)
      // Non-null, and zero: a connection failure bills no tokens.
      expect(row.cost_usd).not.toBeNull()
      expect(Number(row.cost_usd)).toBe(0)
      expect(row.latency_ms).not.toBeNull()
    }
  })

  it('never lets a logging failure mask the model error', async () => {
    // A sink pointed at a table that does not exist: the write fails, the call still returns.
    const brokenClient = {
      from: () => ({ insert: async () => ({ error: { message: 'relation does not exist' } }) }),
    } as unknown as SupabaseClient
    const sink = new SupabaseLogSink(brokenClient)
    process.env.LIVE_API = '1'

    const result = await callModel({
      purpose: 'quality',
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'check this' }],
      sink,
    })
    expect(result.text).toContain('Once upon a time')
    expect(sink.failedWrites).toBe(1)
    expect(sink.lastError).toMatch(/relation does not exist/)
  })

  it.each([
    ['a non-uuid story id (the eval harness correlates by `eval:<scenario>`)', 'eval:titanic-band-b'],
    ['a story id whose row no longer exists', '00000000-0000-4000-8000-000000000000'],
  ])('keeps the cost when a reference is bad: %s', async (_why, storyId) => {
    const sink = new SupabaseLogSink(db)
    const marker = `sink-ref-${Math.random().toString(36).slice(2)}`
    await sink.write({
      family_id: null,
      story_id: storyId,
      fact_pack_id: null,
      purpose: 'judge_score' as never,
      model: 'claude-opus-5-5',
      input_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 5,
      cost_usd: 0.123456,
      latency_ms: 1,
      ok: true,
      error: marker,
    })
    expect(sink.failedWrites, sink.lastError ?? '').toBe(0)

    const { data } = await db.from('generation_logs').select('id, story_id, cost_usd').eq('error', marker)
    world.trackLogIds((data ?? []).map((r) => r.id as string))
    expect(data).toHaveLength(1)
    expect(data![0]!.story_id).toBeNull()
    expect(Number(data![0]!.cost_usd)).toBeCloseTo(0.123456, 6)
  })

  it('keeps generation_logs invisible to a client key', async () => {
    const { data, error } = await anon().from('generation_logs').select('id').limit(1)
    // RLS on with no policy: no rows, no error. Never a leak.
    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})

describe.runIf(reachable)('F8 kill switch and daily budget cap', () => {
  it('returns 503 service_paused when GENERATION_ENABLED=false, before any database read', async () => {
    const family = await world.createFamily({ label: 'killswitch' })
    process.env.GENERATION_ENABLED = 'false'

    const gate = await preflight({ familyId: family.familyId, timezone: 'UTC' })
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.status).toBe(503)
    expect(gate.body.code).toBe('service_paused')
    expect(gate.body.quota_consumed).toBe(false)

    const availability = await generationAvailable()
    expect(availability.enabled).toBe(false)
    expect(availability.reason).toBe('kill_switch')

    // Flipping it back takes effect immediately — no reload, no new module instance.
    process.env.GENERATION_ENABLED = 'true'
    const reopened = await preflight({ familyId: family.familyId, timezone: 'UTC' })
    expect(reopened.ok).toBe(true)
  })

  /** VT: set DAILY_BUDGET_USD=0.01, generate once → subsequent request returns 503. */
  it('pauses for the day once spend passes DAILY_BUDGET_USD', async () => {
    const family = await world.createFamily({ label: 'budget' })
    process.env.DAILY_BUDGET_USD = '0.01'
    process.env.LIVE_API = '1'

    // Generate once, through the real wrapper and the real sink. ~$0.0538 on Sonnet 5.
    const sink = new SupabaseLogSink(db)
    const call = await callModel({
      purpose: 'write',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'tell me a story' }],
      familyId: family.familyId,
      sink,
    })
    await logsFor(family.familyId)
    expect(call.costUsd).toBeGreaterThan(0.01)

    const budget = await budgetStatus(db)
    expect(budget.limitUsd).toBe(0.01)
    expect(budget.spentUsd).toBeGreaterThanOrEqual(call.costUsd)
    expect(budget.exceeded).toBe(true)
    expect(budget.remainingUsd).toBe(0)

    const gate = await preflight({ familyId: family.familyId, timezone: 'UTC' })
    expect(gate.ok).toBe(false)
    if (gate.ok) return
    expect(gate.status).toBe(503)
    expect(gate.body.code).toBe('budget_exceeded')
    expect(gate.body.message).toMatch(/paused for today/i)
    expect(gate.body.quota_consumed).toBe(false)

    // Raising the cap re-opens generation with no deploy and no restart.
    process.env.DAILY_BUDGET_USD = '1000000'
    const reopened = await preflight({ familyId: family.familyId, timezone: 'UTC' })
    expect(reopened.ok).toBe(true)
  })

  it('reads today’s spend from v_budget_today, not from process memory', async () => {
    const family = await world.createFamily({ label: 'budget-view' })
    const before = await budgetStatus(db)

    await world.insertLog({ familyId: family.familyId, costUsd: 0.111111, purpose: 'write' })

    const after = await budgetStatus(db)
    expect(after.spentUsd - before.spentUsd).toBeCloseTo(0.111111, 6)
    expect(after.calls).toBe(before.calls + 1)
    expect(after.day).toBe(new Date().toISOString().slice(0, 10))
  })

  it('ignores yesterday’s spend', async () => {
    const family = await world.createFamily({ label: 'budget-yesterday' })
    const before = await budgetStatus(db)
    await world.insertLog({
      familyId: family.familyId,
      costUsd: 99,
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    })
    const after = await budgetStatus(db)
    expect(after.spentUsd).toBeCloseTo(before.spentUsd, 6)
  })

  it('keeps v_budget_today invisible to a client key', async () => {
    const { error } = await anon().from('v_budget_today').select('spent_usd').limit(1)
    expect(error?.message, 'cost data must not be readable with the anon key').toMatch(/permission denied/i)
  })
})
