import { describe, expect, it } from 'vitest'
import { bandSafetyHolds, onlyHardRuleBreaches, rewriteLost, shorterLength } from '@/lib/generate/pipeline'
import { ModelCallError, ModelRefusalError } from '@/lib/ai'
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

describe('issue #72: which lost rewrites fall back to attempt 1', () => {
  const failed = (message: string, status?: number) =>
    new ModelCallError(`rewrite call to claude-sonnet-5 failed after 4 attempt(s): ${message}`, {
      purpose: 'rewrite', model: 'claude-sonnet-5', attempts: 4, retryable: false, ...(status ? { status } : {}),
    })

  it('VT-F6 a drop, our deadline, a 5xx or a rate limit is a lost rewrite, each with its own code', () => {
    expect(rewriteLost(failed('terminated'))).toBe('rewrite_failed:dropped')
    expect(rewriteLost(failed('Connection error.'))).toBe('rewrite_failed:dropped')
    expect(rewriteLost(failed('deadline: exceeded timeoutMs=600000'))).toBe('rewrite_failed:deadline')
    expect(rewriteLost(failed('overloaded', 529))).toBe('rewrite_failed:status_529')
    expect(rewriteLost(failed('rate limited', 429))).toBe('rewrite_failed:status_429')
    expect(rewriteLost(failed('something else'))).toBe('rewrite_failed:transport')
  })

  it('VT-F6 a 4xx of our own making, a refusal or any other error is not', () => {
    expect(rewriteLost(failed('not_found_error: model', 404))).toBeNull()
    expect(rewriteLost(failed('prompt is too long', 400))).toBeNull()
    expect(rewriteLost(failed('authentication_error', 401))).toBeNull()
    expect(rewriteLost(new ModelRefusalError('claude-sonnet-5', 'cyber', null))).toBeNull()
    expect(rewriteLost(new Error('boom'))).toBeNull()
  })

  it('VT-F6 band safety: scary level over the band, a negative portrayal or an unsafe ending blocks the fallback', () => {
    const safe = { ...base.safety!, safe: true, violations: [] }
    expect(bandSafetyHolds({ ...base, safety: safe }, 'A')).toBe(true)
    expect(bandSafetyHolds({ ...base, safety: null }, 'A')).toBe(true)
    expect(bandSafetyHolds({ ...base, safety: { ...safe, scary_level: 2 } }, 'A')).toBe(false)
    expect(bandSafetyHolds({ ...base, safety: { ...safe, positive_portrayal: false } }, 'C')).toBe(false)
    expect(bandSafetyHolds({ ...base, safety: { ...safe, ending_safe: false } }, 'D')).toBe(false)
  })
})
