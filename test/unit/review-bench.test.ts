import { describe, expect, it } from 'vitest'
import { estimateBuildCost, estimateRunCost, summarizeBench, type BenchReview } from '@/lib/eval/review-bench'

/** Issue #58: the quality-reviewer bench. */

const review = (item_id: string, sample: number, passed: boolean, extra: Partial<BenchReview> = {}): BenchReview => ({
  item_id,
  sample,
  valid: true,
  passed,
  failures: passed ? [] : ['not age-appropriate for band A'],
  reasons: [],
  cost_usd: 0.01,
  ...extra,
})

describe('review bench', () => {
  it('VT-Q3: prints what a build and a run cost before anything is called', () => {
    const build = estimateBuildCost(32)
    const run = estimateRunCost(32, 3)
    // The owner approved about $10 for the set plus six candidate runs.
    expect(build.total_usd).toBeGreaterThan(3)
    expect(build.total_usd).toBeLessThan(6)
    expect(run.total_usd).toBeGreaterThan(0.2)
    expect(run.total_usd).toBeLessThan(1.2)
    expect(run.lines[0]?.calls).toBe(96)
  })

  it('VT-Q4: counts format failures, wrong fails, catches and flips against the hand labels', () => {
    const reviews = [
      // labelled should_pass: one wrong fail in three, and a flip
      review('good', 1, true),
      review('good', 2, false),
      review('good', 3, true),
      // labelled should fail: caught twice, one answer did not validate (fail-closed counts as a fail)
      review('bad', 1, false),
      review('bad', 2, false, { valid: false, raw_text: '{"age_appropriate": tru' }),
      review('bad', 3, true, { reasons: ['x'.repeat(42)] }),
      // unlabelled: only format and flips count
      review('other', 1, true),
    ]
    const s = summarizeBench(reviews, [
      { id: 'good', should_pass: true, notes: '' },
      { id: 'bad', should_pass: false, notes: 'Chapter 3: "extinct" never explained' },
    ])
    expect(s).toMatchObject({
      calls: 7,
      format_failures: 1,
      wrong_fails: { count: 1, of: 3 },
      catches: { count: 2, of: 3 },
      flips: { count: 2, of: 3 },
      longest_reason: 42,
    })
    expect(s.cost_usd).toBeCloseTo(0.07)
  })

  it('without labels, reports format failures and flips only', () => {
    const s = summarizeBench([review('a', 1, true), review('a', 2, true)], null)
    expect(s.wrong_fails).toEqual({ count: 0, of: 0 })
    expect(s.flips).toEqual({ count: 0, of: 1 })
  })
})
