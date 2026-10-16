import { describe, expect, it } from 'vitest'
import { EXPECTED_REWRITE_RATE, estimateBakeoffCost, estimateEvalCost } from '@/lib/eval/estimate'
import { bakeoffScenarios, evalScenarios } from '@/lib/eval/scenarios'

/**
 * F13 / F14: a built fact pack is shared, so a run that finds it `ready` pays nothing to
 * research it. With the packs built, the cold-library estimate overstated `pnpm eval` by ~$13
 * — an estimate that wrong in either direction stops being read.
 */
const packLine = (e: { lines: { what: string; calls: number; usd: number }[] }) =>
  e.lines.find((l) => l.what.startsWith('fact packs'))!

describe('F13/F14 estimates skip fact packs that are already built', () => {
  it('eval: charges only for topics not yet built', () => {
    const topics = [...new Set(evalScenarios().map((s) => s.topic_key))]
    const cold = estimateEvalCost()
    const warm = estimateEvalCost({ builtTopics: new Set(topics.slice(1)) })

    expect(packLine(cold).calls).toBe(topics.length)
    expect(packLine(warm).calls).toBe(1)
    expect(packLine(warm).usd).toBeCloseTo(packLine(cold).usd / topics.length, 6)
    expect(cold.total_usd - warm.total_usd).toBeCloseTo(packLine(cold).usd - packLine(warm).usd, 6)
  })

  it('bake-off: a fully built library costs nothing for packs', () => {
    const topics = new Set(bakeoffScenarios().map((s) => s.topic_key))
    const warm = estimateBakeoffCost({ builtTopics: topics })
    expect(packLine(warm).calls).toBe(0)
    expect(packLine(warm).usd).toBe(0)
  })
})

describe('the eval estimate is reconciled with what a run actually cost', () => {
  it('VT-E1: the 32-story eval is within 15% of the measured 2026-10-14 run ($14.15, calibration reused)', () => {
    const topics = new Set(evalScenarios().map((s) => s.topic_key))
    const estimate = estimateEvalCost({ builtTopics: topics, includeCalibration: false })
    // Measured from generation_logs: $10.45 generation (of which $4.06 rewrites) + $3.70 judging.
    // If a price, a prompt or the rewrite rate moves, re-measure and update both together.
    expect(estimate.total_usd).toBeGreaterThan(14.15 * 0.85)
    expect(estimate.total_usd).toBeLessThan(14.15 * 1.15)
  })

  it('VT-E2: rewrites are a line of their own, at the measured rate', () => {
    const estimate = estimateEvalCost({ includeCalibration: false })
    const rewrites = estimate.lines.find((l) => l.what.startsWith('rewrites'))
    expect(rewrites?.usd).toBeGreaterThan(0)
    expect(EXPECTED_REWRITE_RATE).toBe(0.7)
    expect(estimate.assumptions.join(' ')).toMatch(/Rewrite rate 0\.7/)
    const bakeoff = estimateBakeoffCost()
    expect(bakeoff.lines.some((l) => l.what.startsWith('rewrites on'))).toBe(true)
  })
})
