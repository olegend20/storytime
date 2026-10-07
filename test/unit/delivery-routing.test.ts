import { describe, expect, it } from 'vitest'
import { onlyHardRuleBreaches, shorterLength } from '@/lib/generate/pipeline'
import type { QualityResult } from '@/lib/schemas'

/**
 * Issue #32: when attempt 1 failed only on located hard-rule breaches, it is mended (ten
 * seconds) instead of rewritten (two minutes). Decided from the result's structure, so
 * rewording a reason string can never change the route.
 */
const base: QualityResult = {
  outcome: 'rewrite',
  attempt: 1,
  deterministic_passed: true,
  failures: [],
  review: null,
  safety: { safe: false, violations: [{ rule: 7, quote: 'Elsa waved', severity: 'hard' }], scary_level: 0, positive_portrayal: true, ending_safe: true },
  hard_violations: [{ rule: 7, quote: 'Elsa waved', severity: 'hard' }],
  rewrite_reasons: ['reworded entirely - the route must not care'],
  word_count: 1400,
  target_words: { min: 1300, max: 1700 },
}

describe('which failures the mend can take instead of a rewrite', () => {
  it('a hard breach and nothing else: mend', () => {
    expect(onlyHardRuleBreaches(base, 'A')).toBe(true)
  })
  it('no hard breach: rewrite', () => {
    expect(onlyHardRuleBreaches({ ...base, hard_violations: [] }, 'A')).toBe(false)
  })
  it('a deterministic failure as well (length, a missing child): rewrite', () => {
    expect(onlyHardRuleBreaches({ ...base, failures: [{ check: 'word_count_in_range', detail: 'short' }] }, 'A')).toBe(false)
  })
  it('too scary for the band, a child belittled, or an unsafe ending as well: rewrite', () => {
    expect(onlyHardRuleBreaches({ ...base, safety: { ...base.safety!, scary_level: 2 } }, 'A')).toBe(false)
    expect(onlyHardRuleBreaches({ ...base, safety: { ...base.safety!, positive_portrayal: false } }, 'A')).toBe(false)
    expect(onlyHardRuleBreaches({ ...base, safety: { ...base.safety!, ending_safe: false } }, 'A')).toBe(false)
    // The same scary level is within band C's limit.
    expect(onlyHardRuleBreaches({ ...base, safety: { ...base.safety!, scary_level: 2 } }, 'C')).toBe(true)
  })
})

describe('rung 3: one length tier shorter', () => {
  it('15 -> 10 -> 5, and the shortest stays', () => {
    expect(shorterLength(15)).toBe(10)
    expect(shorterLength(10)).toBe(5)
    expect(shorterLength(5)).toBe(5)
  })
})

describe('rung 4: when the writer counts as unavailable', () => {
  it('overloaded, a server error, rate-limited, a dropped stream: yes', async () => {
    const { writerUnavailable } = await import('@/lib/generate/pipeline')
    const { ModelCallError, ModelRefusalError } = await import('@/lib/ai')
    const err = (status?: number, message = 'x') =>
      new ModelCallError(message, { purpose: 'write', model: 'm', attempts: 1, retryable: false, ...(status ? { status } : {}) })
    expect(writerUnavailable(err(529))).toBe(true)
    expect(writerUnavailable(err(500))).toBe(true)
    expect(writerUnavailable(err(429))).toBe(true)
    expect(writerUnavailable(err(undefined, 'write stream failed: overloaded_error'))).toBe(true)
    expect(writerUnavailable(new Error('socket hang up'))).toBe(true)
    // Not unavailable: a bad request, an exhausted balance (the fallback fails the same way),
    // an auth error, a refusal.
    expect(writerUnavailable(err(400, 'credit balance is too low'))).toBe(false)
    expect(writerUnavailable(err(401))).toBe(false)
    expect(writerUnavailable(new ModelRefusalError('m', null, null))).toBe(false)
  })
})
