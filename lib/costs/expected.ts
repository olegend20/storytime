import { computeCost, modelForRole } from '@/lib/ai/pricing'

/**
 * The expected cost of one story, derived from the IMPLEMENTATION_PLAN §5 token table and
 * the prices in `config/pricing.json`. Nothing here is a hard-coded dollar figure — change
 * a price in config and these move with it.
 *
 * Why it exists: /admin needs something to compare the MEASURED median against. A median
 * far outside this band means the token mix is wrong (a runaway prompt, history leaking
 * into context, a regeneration loop), and that is worth shouting about before the bill
 * arrives rather than after.
 *
 * Caveat that matters for cross-model comparison: Haiku 4.5 uses an older tokenizer than
 * Sonnet 5 / Opus 5.5 / Fable 5.1 and produces roughly 30% fewer tokens for identical text.
 * These estimates hold token counts constant, so a real Haiku story lands BELOW its
 * estimate here while a Sonnet story lands near it. Never compare models on word-count
 * estimates — compare measured `generation_logs` tokens, which is what `v_story_cost_by_writer`
 * does.
 */

/** §5 "Per story, expected calls". Fact-pack build is excluded: it amortizes to ~0. */
export const EXPECTED_CALLS = {
  /** Haiku: normalize the parent's topic into a `topic_key`. */
  normalize: { role: 'helper', input: 300, cacheRead: 0, output: 50 },
  /** The call that matters: cached master prompt + bible + fact pack, one story out. */
  write: { role: 'writer', input: 1_500, cacheRead: 4_000, output: 5_000 },
  /** Haiku: the F7 quality gate reads the whole story back. */
  quality: { role: 'helper', input: 6_000, cacheRead: 0, output: 200 },
  /** Haiku: background Story Bible update. */
  bible_update: { role: 'helper', input: 7_000, cacheRead: 0, output: 600 },
} as const

export type ExpectedCallName = keyof typeof EXPECTED_CALLS

export interface ExpectedStoryCost {
  writerModel: string
  helperModel: string
  /** Per-step breakdown in USD. */
  breakdown: Record<ExpectedCallName, number>
  totalUsd: number
  /**
   * Share of the whole story's cost spent on output tokens across all four calls.
   * NOT a constant across models: it rises with the writer's output:input price ratio
   * (~66% on Haiku 4.5, ~76% on Sonnet 5, ~90% on Fable 5.1), because the helper calls are
   * input-heavy and stay on Haiku whatever the writer is.
   */
  outputShare: number
  /**
   * Output tokens of the single write call as a share of the whole story. This is the ~70%
   * figure for the configured Sonnet 5 writer, and it is the number that matters
   * operationally: the lever on cost per story is story LENGTH and regeneration count, not
   * prompt size.
   */
  writeOutputShare: number
}

/**
 * @param writerModel defaults to the configured `writer` role (env override respected).
 */
export function expectedStoryCost(
  writerModel: string = modelForRole('writer'),
  helperModel: string = modelForRole('helper'),
): ExpectedStoryCost {
  const breakdown = {} as Record<ExpectedCallName, number>
  let outputUsd = 0
  let writeOutputUsd = 0

  for (const [name, call] of Object.entries(EXPECTED_CALLS) as [
    ExpectedCallName,
    (typeof EXPECTED_CALLS)[ExpectedCallName],
  ][]) {
    const model = call.role === 'writer' ? writerModel : helperModel
    breakdown[name] = computeCost({
      model,
      input: call.input,
      cacheRead: call.cacheRead,
      output: call.output,
    })
    const outOnly = computeCost({ model, input: 0, output: call.output })
    outputUsd += outOnly
    if (name === 'write') writeOutputUsd = outOnly
  }

  const totalUsd =
    Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0) * 1e6) / 1e6

  return {
    writerModel,
    helperModel,
    breakdown,
    totalUsd,
    outputShare: totalUsd === 0 ? 0 : outputUsd / totalUsd,
    writeOutputShare: totalUsd === 0 ? 0 : writeOutputUsd / totalUsd,
  }
}

/**
 * How wide a band around the estimate counts as "fine". §5 gives output as a 4–6k range,
 * so ±35% covers the legitimate spread of story lengths and one regeneration on a minority
 * of stories without swallowing a real regression.
 */
export const EXPECTED_COST_TOLERANCE = 0.35

export interface CostSanity {
  expectedUsd: number
  measuredUsd: number | null
  minUsd: number
  maxUsd: number
  verdict: 'no-data' | 'in-band' | 'below-band' | 'above-band'
}

/** Compare a measured median cost per story against the config-derived estimate. */
export function assessMedianCost(
  measuredUsd: number | null,
  writerModel: string = modelForRole('writer'),
): CostSanity {
  const expectedUsd = expectedStoryCost(writerModel).totalUsd
  const minUsd = Math.round(expectedUsd * (1 - EXPECTED_COST_TOLERANCE) * 1e6) / 1e6
  const maxUsd = Math.round(expectedUsd * (1 + EXPECTED_COST_TOLERANCE) * 1e6) / 1e6

  let verdict: CostSanity['verdict'] = 'no-data'
  if (measuredUsd !== null) {
    if (measuredUsd < minUsd) verdict = 'below-band'
    else if (measuredUsd > maxUsd) verdict = 'above-band'
    else verdict = 'in-band'
  }

  return { expectedUsd, measuredUsd, minUsd, maxUsd, verdict }
}
