import { describe, expect, it, vi } from 'vitest'

/**
 * F6/F8/F15: `/api/stories/generate` passes the real quota, input guard and L4 reviewer to
 * BOTH halves of the pipeline. Before this test existed the route passed none, and every
 * other test still passed - the stubs in `lib/generate/deps.ts` allow everything, and a
 * guard that is never called cannot fail.
 */

const calls = vi.hoisted(() => ({ prepare: [] as unknown[][], precheck: [] as unknown[][], precheckFails: false }))

vi.mock('next/server', () => ({ after: () => {} }))
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { id: 'family-1' } }) }) }),
      }),
    }),
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ supabaseService: () => ({}) }))
vi.mock('@/lib/generate', async (orig) => ({
  ...(await orig<typeof import('@/lib/generate')>()),
  precheckGeneration: async (...args: unknown[]) => {
    calls.precheck.push(args)
    return calls.precheckFails
      ? { ok: false, status: 429, error: { code: 'quota_exceeded', message: 'q', quota_consumed: false, resets_at: '2026-10-09T00:00:00.000Z' } }
      : { ok: true }
  },
  prepareGeneration: async (...args: unknown[]) => {
    calls.prepare.push(args)
    return {
      ok: false,
      status: 422,
      error: { code: 'topic_refused', message: 'x', quota_consumed: false, resets_at: null },
    }
  },
}))

const { POST } = await import('@/app/api/stories/generate/route')
const { LimitsQuotaService, GuardrailsInputGuard, GuardrailsSafetyReviewer } = await import(
  '@/lib/generate/production-deps'
)

describe('the generate route wires the real guardrails and limits', () => {
  it('passes production deps to prepareGeneration', async () => {
    const res = await POST(
      new Request('http://localhost/api/stories/generate', { method: 'POST', body: '{}' }),
    )
    // The stream opens at once (2026-10-08: a phone gave up during a silent fact-pack build);
    // a refusal from the slow checks arrives as the stream's error event.
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await res.text()
    expect(text).toContain('"type":"error"')
    expect(text).toContain('"code":"topic_refused"')
    expect(calls.prepare).toHaveLength(1)
    expect((calls.precheck[0] as unknown[])[2]).toBe(calls.prepare[0]![2])
    const [familyId, , deps] = calls.prepare[0] as [string, unknown, Record<string, unknown>]
    expect(familyId).toBe('family-1')
    expect(deps.quota).toBeInstanceOf(LimitsQuotaService)
    expect(deps.inputGuard).toBeInstanceOf(GuardrailsInputGuard)
    expect(deps.safetyReviewer).toBeInstanceOf(GuardrailsSafetyReviewer)
  })

  it('the cheap checks still answer with a real status, before any stream', async () => {
    calls.precheckFails = true
    try {
      const res = await POST(new Request('http://localhost/api/stories/generate', { method: 'POST', body: '{}' }))
      expect(res.status).toBe(429)
      expect(await res.json()).toMatchObject({ code: 'quota_exceeded' })
    } finally {
      calls.precheckFails = false
    }
  })

  it('hands the same deps to runGeneration', async () => {
    // Structural, because driving the stream half needs a live model: the one `deps` object
    // built in the route must be the one both calls receive.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('app/api/stories/generate/route.ts', 'utf8')
    expect(src).toMatch(/prepareGeneration\(familyId,\s*body,\s*deps\)/)
    expect(src).toMatch(/precheckGeneration\(familyId,\s*body,\s*deps\)/)
    expect(src).toMatch(/runGeneration\(prepared\.prepared,\s*channel,\s*deps\)/)
    // ...and carries the request deadline, so a retry never outlives the function (#32).
    expect(src).toMatch(/const deps = \{ \.\.\.productionDeps\(\), deadlineMs: startedAt \+ maxDuration \* 1000 \}/)
  })
})
