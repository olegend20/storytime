import { computeCost } from '@/lib/ai/pricing'
import { modelForRole } from '@/lib/ai/pricing'
import { classifierSystemPrompt } from '@/lib/guardrails/classify'

/**
 * Cost estimate for a live corpus run, from config/pricing.json - never from memory
 * (CLAUDE.md rule 2). The lead asks for the number before any live run, so it is computed
 * rather than asserted.
 *
 * Token counts are approximated at 4 characters per token. Haiku 4.5 uses the older
 * tokenizer, which runs lower than the 4.7+ models for the same text, so this estimate is
 * conservative (it over-estimates rather than under).
 */

const CHARS_PER_TOKEN = 4
/** Observed shape of a classifier reply: the JSON object plus a short care/parent line. */
const OUTPUT_TOKENS_PER_CALL = 180
/** Per-entry user message: the age line plus three short data blocks. */
const USER_TOKENS_PER_CALL = 120

export interface CorpusCostEstimate {
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  usd: number
  /** Cost if every call missed the prompt cache (the pessimistic bound). */
  usdUncached: number
}

export function estimateCorpusCostUsd(calls: number): CorpusCostEstimate {
  const model = modelForRole('helper')
  const systemTokens = Math.ceil(classifierSystemPrompt().length / CHARS_PER_TOKEN)

  // First call writes the cached system prefix; the rest read it.
  const cacheWrite = systemTokens
  const cacheRead = systemTokens * Math.max(0, calls - 1)
  const uncachedInput = USER_TOKENS_PER_CALL * calls
  const output = OUTPUT_TOKENS_PER_CALL * calls

  const usd = computeCost({
    model,
    input: uncachedInput,
    cacheWrite,
    cacheRead,
    output,
  })
  const usdUncached = computeCost({
    model,
    input: systemTokens * calls + uncachedInput,
    output,
  })

  return {
    model,
    calls,
    inputTokens: uncachedInput + cacheWrite + cacheRead,
    outputTokens: output,
    usd,
    usdUncached,
  }
}
