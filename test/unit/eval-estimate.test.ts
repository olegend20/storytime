import { describe, expect, it } from 'vitest'
import { estimateBakeoffCost, estimateEvalCost } from '@/lib/eval/estimate'
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
