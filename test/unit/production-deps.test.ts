import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The route must run the REAL quota, guardrails and L4 review.
 *
 * `lib/generate/deps.ts` ships stubs that allow everything, so lanes could land apart. After
 * the merge, `/api/stories/generate` still passed no deps: every topic was allowed, no story
 * had an L4 review, and there was no quota or budget cap. Nothing failed, because a stub that
 * allows is indistinguishable from a guard that allowed. These tests pin the wiring.
 */

const mocks = vi.hoisted(() => ({
  preflight: vi.fn(),
  consumeQuota: vi.fn(),
  quotaStatus: vi.fn(),
  guardInput: vi.fn(),
  reviewOutput: vi.fn(),
  scanStoryStructure: vi.fn(),
  prepareGeneration: vi.fn(),
  runGeneration: vi.fn(),
}))

vi.mock('@/lib/limits', async (orig) => ({
  ...(await orig<typeof import('@/lib/limits')>()),
  preflight: mocks.preflight,
  consumeQuota: mocks.consumeQuota,
  quotaStatus: mocks.quotaStatus,
}))
vi.mock('@/lib/guardrails', async (orig) => ({
  ...(await orig<typeof import('@/lib/guardrails')>()),
  guardInput: mocks.guardInput,
  reviewOutput: mocks.reviewOutput,
  scanStoryStructure: mocks.scanStoryStructure,
}))
vi.mock('@/lib/supabase/service', () => ({ supabaseService: () => ({}) }))

const { LimitsQuotaService, GuardrailsInputGuard, GuardrailsSafetyReviewer, productionDeps } =
  await import('@/lib/generate/production-deps')

const snapshot = {
  used: 1,
  limit: 3,
  remaining: 2,
  usageDate: '2026-09-28',
  resetsAt: '2026-09-29T07:00:00.000Z',
  timezone: 'America/Los_Angeles',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LimitsQuotaService maps lane 3 onto the pipeline seam', () => {
  it('allows when preflight allows', async () => {
    mocks.preflight.mockResolvedValue({ ok: true, quota: snapshot, budget: null })
    const q = await new LimitsQuotaService().preflight('fam')
    expect(q).toMatchObject({ allowed: true, generation_enabled: true, used: 1, limit: 3 })
  })

  it('reports the quota block with the local reset time', async () => {
    mocks.preflight.mockResolvedValue({
      ok: false,
      status: 429,
      body: { code: 'quota_exceeded', message: 'x', quota_consumed: false, resets_at: snapshot.resetsAt },
      quota: { ...snapshot, used: 3, remaining: 0 },
      budget: null,
    })
    const q = await new LimitsQuotaService().preflight('fam')
    expect(q).toMatchObject({ allowed: false, generation_enabled: true, resets_at: snapshot.resetsAt })
  })

  it.each(['service_paused', 'budget_exceeded'] as const)('turns %s into a disabled service', async (code) => {
    mocks.preflight.mockResolvedValue({
      ok: false,
      status: 503,
      body: { code, message: 'x', quota_consumed: false, resets_at: null },
      quota: null,
      budget: null,
    })
    const q = await new LimitsQuotaService().preflight('fam')
    expect(q).toMatchObject({ allowed: false, generation_enabled: false, disabled_reason: code })
  })

  it('consumes through lane 3', async () => {
    mocks.consumeQuota.mockResolvedValue({ ...snapshot, used: 2, allowed: true })
    const q = await new LimitsQuotaService().consumeQuota('fam')
    expect(mocks.consumeQuota).toHaveBeenCalledWith(expect.objectContaining({ familyId: 'fam' }))
    expect(q.used).toBe(2)
  })
})

describe('GuardrailsInputGuard maps lane 6 L1+L2 onto the pipeline seam', () => {
  const children = [
    { id: 'a', first_name: 'Milo', age: 7, likes: ['LEGO'], notes: null },
    { id: 'b', first_name: 'Juno', age: 4, likes: [], notes: null },
  ]

  it('passes every child and the youngest name, and returns the refusal copy', async () => {
    mocks.guardInput.mockResolvedValue({
      decision: 'refuse',
      category: 'violence',
      careNotes: null,
      topicKeyHint: null,
      parentMessage: 'Let us pick a different topic.',
      classification: null,
    })
    const r = await new GuardrailsInputGuard().check({
      topicInput: 'something',
      children: children as never,
      youngestAge: 4,
      familyId: 'fam',
    })
    expect(mocks.guardInput).toHaveBeenCalledWith(
      expect.objectContaining({
        topic_input: 'something',
        youngestAge: 4,
        youngestName: 'Juno',
        familyId: 'fam',
        children: [
          { first_name: 'Milo', likes: ['LEGO'], notes: null },
          { first_name: 'Juno', likes: [], notes: null },
        ],
      }),
    )
    expect(r).toMatchObject({ decision: 'refuse', category: 'violence', parent_message: 'Let us pick a different topic.' })
  })

  it('carries care notes through for allow_with_care', async () => {
    mocks.guardInput.mockResolvedValue({
      decision: 'allow_with_care',
      category: 'sensitive_history',
      careNotes: 'Handle gently.',
      topicKeyHint: 'the-titanic',
      parentMessage: null,
      classification: { min_recommended_age: 6 },
    })
    const r = await new GuardrailsInputGuard().check({ topicInput: 't', children: children as never, youngestAge: 7 })
    expect(r).toMatchObject({ decision: 'allow_with_care', care_notes: 'Handle gently.', min_recommended_age: 6 })
  })
})

describe('GuardrailsSafetyReviewer runs lane 6 L4', () => {
  const story = { title: 't', subtitle: null, chapters: [{ heading: 'h', text: 'Once.' }], ending_line: 'e', true_facts: [] }
  const request = { children: [{ name: 'Milo' }], age_band: 'B' }
  const safe = { safe: true, violations: [], scary_level: 0, positive_portrayal: true, ending_safe: true }

  it('returns the model review when the scan finds nothing hard', async () => {
    mocks.scanStoryStructure.mockReturnValue({ violations: [] })
    mocks.reviewOutput.mockResolvedValue({ review: safe, costUsd: 0.001 })
    const r = await new GuardrailsSafetyReviewer().review(story as never, request as never, {})
    expect(r).toEqual(safe)
    expect(mocks.reviewOutput).toHaveBeenCalledWith(expect.objectContaining({ band: 'B', childNames: ['Milo'] }))
  })

  it('a hard deterministic violation fails the story even if the model says safe', async () => {
    const hard = { rule: 3, severity: 'hard', quote: 'x' }
    mocks.scanStoryStructure.mockReturnValue({ violations: [hard] })
    mocks.reviewOutput.mockResolvedValue({ review: safe, costUsd: 0.001 })
    const r = await new GuardrailsSafetyReviewer().review(story as never, request as never, {})
    expect(r.safe).toBe(false)
    expect(r.violations).toContainEqual(hard)
  })
})

describe('productionDeps', () => {
  it('has no stubs', () => {
    const deps = productionDeps({} as never)
    for (const dep of [deps.quota, deps.inputGuard, deps.safetyReviewer]) {
      expect(dep).toBeDefined()
      expect((dep as { isStub?: boolean }).isStub).toBeUndefined()
    }
  })
})
