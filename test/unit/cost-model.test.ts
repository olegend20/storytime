import { describe, expect, it } from 'vitest'
import { assessMedianCost, EXPECTED_CALLS, expectedStoryCost } from '@/lib/costs/expected'
import { computeCost } from '@/lib/ai/pricing'

/**
 * F8 / F12: the expected cost per story, derived from the §5 token table and
 * `config/pricing.json`. These are the numbers /admin judges the MEASURED median against,
 * so they need to be right, and they need to move if a price in config moves.
 *
 * The four totals below are the medians named in the lane brief. If a price changes and one
 * of these drifts, that is the signal to re-check the brief's band — not to edit the number
 * here to match.
 */
describe('F8 expected cost per story', () => {
  const HELPER = 'claude-haiku-4-5-20251001'

  it.each([
    ['claude-haiku-4-5-20251001', 0.045],
    ['claude-sonnet-5', 0.071],
    ['claude-opus-5-5', 0.125],
    ['claude-fable-5-1', 0.284],
  ] as const)('%s writes a story for about $%s', (writer, expected) => {
    const got = expectedStoryCost(writer, HELPER)
    // Within 2% of the brief's figure. Opus lands at $0.12435 against a quoted $0.125, so a
    // 3dp absolute check would fail on rounding alone; 2% is tight enough that a real price
    // or token-table change still trips it.
    expect(got.totalUsd, `${writer}: ${JSON.stringify(got.breakdown)}`).toBeGreaterThan(expected * 0.98)
    expect(got.totalUsd, `${writer}: ${JSON.stringify(got.breakdown)}`).toBeLessThan(expected * 1.02)
  })

  /**
   * The brief: "output tokens dominate at roughly 70% of the total". That holds for the
   * configured Sonnet 5 writer when measured on the write call's output, which is the number
   * that matters: the lever on cost per story is story LENGTH and regeneration count, not
   * prompt size.
   */
  it('spends about 70% of a Sonnet 5 story on the write call output tokens', () => {
    const { writeOutputShare } = expectedStoryCost('claude-sonnet-5', HELPER)
    expect(writeOutputShare).toBeGreaterThan(0.68)
    expect(writeOutputShare).toBeLessThan(0.72)
  })

  /**
   * The share itself is NOT a constant across writers, so nothing in the codebase should
   * treat "70% output" as a universal rule: it climbs with the writer's output:input price
   * ratio while the input-heavy helper calls stay on Haiku.
   */
  it('has output dominate for every candidate writer, but at a model-specific share', () => {
    // Ordered cheapest output price first.
    const writers = ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1']
    const shares = writers.map((w) => ({ writer: w, share: expectedStoryCost(w, HELPER).outputShare }))
    for (const { writer, share } of shares) {
      expect(share, writer).toBeGreaterThan(0.6)
      expect(share, writer).toBeLessThan(0.95)
    }
    for (let i = 1; i < shares.length; i += 1) {
      expect(shares[i]!.share, `${shares[i]!.writer} vs ${shares[i - 1]!.writer}`).toBeGreaterThan(
        shares[i - 1]!.share,
      )
    }
  })

  /** The whole point of the §5 architecture: the write call dwarfs the three helper calls. */
  it('puts most of the money in the single write call', () => {
    const { breakdown, totalUsd } = expectedStoryCost('claude-sonnet-5', HELPER)
    const helpers = breakdown.normalize + breakdown.quality + breakdown.bible_update
    expect(breakdown.write).toBeGreaterThan(helpers)
    expect(breakdown.write / totalUsd).toBeGreaterThan(0.7)
  })

  it('reprices itself from config rather than from a hard-coded total', () => {
    // Re-derive the write step by hand from the table and the price file.
    const call = EXPECTED_CALLS.write
    const byHand = computeCost({
      model: 'claude-sonnet-5',
      input: call.input,
      cacheRead: call.cacheRead,
      output: call.output,
    })
    expect(expectedStoryCost('claude-sonnet-5', HELPER).breakdown.write).toBeCloseTo(byHand, 6)
  })
})

describe('F12 median-cost sanity band', () => {
  it('accepts a measured median near the estimate', () => {
    const expected = expectedStoryCost('claude-sonnet-5').totalUsd
    expect(assessMedianCost(expected, 'claude-sonnet-5').verdict).toBe('in-band')
    expect(assessMedianCost(expected * 1.2, 'claude-sonnet-5').verdict).toBe('in-band')
  })

  it('flags a median far above the estimate — the runaway-prompt case', () => {
    const expected = expectedStoryCost('claude-sonnet-5').totalUsd
    expect(assessMedianCost(expected * 3, 'claude-sonnet-5').verdict).toBe('above-band')
  })

  it('flags a median far below the estimate — usually stories logged without a write call', () => {
    expect(assessMedianCost(0.001, 'claude-sonnet-5').verdict).toBe('below-band')
  })

  it('reports no-data rather than a false green before any story exists', () => {
    expect(assessMedianCost(null).verdict).toBe('no-data')
  })

  /**
   * Cross-model comparison: judging every model against ONE model's expected cost would
   * label Haiku "below band" and Fable "above band" forever. Each model is judged against
   * its own estimate.
   */
  it('judges each writing model against its own expected cost', () => {
    const haiku = expectedStoryCost('claude-haiku-4-5-20251001').totalUsd
    expect(assessMedianCost(haiku, 'claude-haiku-4-5-20251001').verdict).toBe('in-band')
    expect(assessMedianCost(haiku, 'claude-fable-5-1').verdict).toBe('below-band')
  })
})
