import { describe, expect, it, vi } from 'vitest'

/**
 * F6/F8/F15: `/api/stories/generate` passes the real quota, input guard and L4 reviewer to
 * BOTH halves of the pipeline. Before this test existed the route passed none, and every
 * other test still passed - the stubs in `lib/generate/deps.ts` allow everything, and a
 * guard that is never called cannot fail.
 */

const calls = vi.hoisted(() => ({ prepare: [] as unknown[][] }))

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
    expect(res.status).toBe(422)
    expect(calls.prepare).toHaveLength(1)
    const [familyId, , deps] = calls.prepare[0] as [string, unknown, Record<string, unknown>]
    expect(familyId).toBe('family-1')
    expect(deps.quota).toBeInstanceOf(LimitsQuotaService)
    expect(deps.inputGuard).toBeInstanceOf(GuardrailsInputGuard)
    expect(deps.safetyReviewer).toBeInstanceOf(GuardrailsSafetyReviewer)
  })

  it('hands the same deps to runGeneration', async () => {
    // Structural, because driving the stream half needs a live model: the one `deps` object
    // built in the route must be the one both calls receive.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('app/api/stories/generate/route.ts', 'utf8')
    expect(src).toMatch(/prepareGeneration\(.*,\s*body,\s*deps\)/)
    expect(src).toMatch(/runGeneration\(prepared\.prepared,\s*channel,\s*deps\)/)
  })
})
