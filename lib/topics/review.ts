import {
  FACT_PACK_MAX_FACTS,
  FACT_PACK_MIN_FACTS,
  FACT_PACK_TOKEN_LIMIT,
  FactPack,
  FactPackReview,
  type Confidence,
} from '@/lib/schemas'
import { estimateTokens } from '@/lib/prompts'
import { callModel, type GenerationLogSink } from '@/lib/ai'
import { loadPrompt } from '@/lib/prompts'
import { dataBlock } from '@/lib/datablock'

/**
 * Fact-pack review (F5). Two passes, cheap one first:
 *
 *  1. `reviewFactPackDeterministic` - free. Fact count, sources, confidence, size, and the
 *     kid_safe/sensitive_notes pairing. Runs on the raw parsed object, before zod, so an
 *     11-fact pack produces the reason code rather than an opaque schema error.
 *  2. `reviewFactPackWithModel` - one Haiku call for the judgement code cannot make:
 *     contradictions, wrong dates, un-hedged legends, vague filler.
 *
 * A deterministic rejection skips the model call entirely, the same economy as F7's gate.
 */

/** Stable reason prefixes. Tests assert on these, not on prose. */
export type FactPackRejectReason =
  | `too_few_facts:${number}`
  | `too_many_facts:${number}`
  | `fact_without_source:${string}`
  | `fact_unknown_source:${string}`
  | `fact_without_confidence:${string}`
  | `duplicate_fact_id:${string}`
  | `pack_too_large:${number}`
  | 'missing_sensitive_notes'
  | 'no_sources'
  | 'bad_topic_key'
  | 'no_summary'
  | 'unparseable'

export interface DeterministicReview {
  accept: boolean
  reasons: FactPackRejectReason[]
  /** Set when the object validated against the FactPack schema. */
  pack: FactPack | null
  tokenEstimate: number
}

const CONFIDENCES: readonly string[] = ['high', 'medium', 'legend'] satisfies Confidence[]

/** Works on an unvalidated object: the point is to name what is wrong, not to throw. */
export function reviewFactPackDeterministic(candidate: unknown): DeterministicReview {
  const reasons: FactPackRejectReason[] = []
  const tokenEstimate = estimateTokens(JSON.stringify(candidate ?? null))

  if (!candidate || typeof candidate !== 'object') {
    return { accept: false, reasons: ['unparseable'], pack: null, tokenEstimate }
  }
  const obj = candidate as Record<string, unknown>

  if (typeof obj.topic_key !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(obj.topic_key)) {
    reasons.push('bad_topic_key')
  }
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') reasons.push('no_summary')

  const sources = Array.isArray(obj.sources) ? obj.sources : []
  if (sources.length === 0) reasons.push('no_sources')
  const sourceIds = new Set(
    sources
      .map((s) => (s as Record<string, unknown>)?.id)
      .filter((id): id is string => typeof id === 'string'),
  )

  const facts = Array.isArray(obj.facts) ? obj.facts : []
  if (facts.length < FACT_PACK_MIN_FACTS) reasons.push(`too_few_facts:${facts.length}`)
  if (facts.length > FACT_PACK_MAX_FACTS) reasons.push(`too_many_facts:${facts.length}`)

  const seenIds = new Set<string>()
  let hasUnsafeFact = false
  for (const [index, raw] of facts.entries()) {
    const fact = (raw ?? {}) as Record<string, unknown>
    const id = typeof fact.id === 'string' && fact.id !== '' ? fact.id : `#${index + 1}`
    if (seenIds.has(id)) reasons.push(`duplicate_fact_id:${id}`)
    seenIds.add(id)

    const cited = Array.isArray(fact.source_ids)
      ? fact.source_ids.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : []
    if (cited.length === 0) reasons.push(`fact_without_source:${id}`)
    for (const sid of cited) {
      if (!sourceIds.has(sid)) reasons.push(`fact_unknown_source:${id}`)
    }

    if (typeof fact.confidence !== 'string' || !CONFIDENCES.includes(fact.confidence)) {
      reasons.push(`fact_without_confidence:${id}`)
    }
    if (fact.kid_safe === false) hasUnsafeFact = true
  }

  const sensitive = typeof obj.sensitive_notes === 'string' ? obj.sensitive_notes.trim() : ''
  if (hasUnsafeFact && sensitive === '') reasons.push('missing_sensitive_notes')

  if (tokenEstimate > FACT_PACK_TOKEN_LIMIT) reasons.push(`pack_too_large:${tokenEstimate}`)

  const parsed = FactPack.safeParse(candidate)
  if (!parsed.success && reasons.length === 0) reasons.push('unparseable')

  return {
    accept: reasons.length === 0,
    reasons,
    pack: parsed.success ? parsed.data : null,
    tokenEstimate,
  }
}

export interface ModelReviewOptions {
  sink?: GenerationLogSink
  factPackId?: string | null
  signal?: AbortSignal
}

/** The Haiku judgement pass. Only called when the deterministic review accepted. */
export async function reviewFactPackWithModel(
  pack: FactPack,
  opts: ModelReviewOptions = {},
): Promise<FactPackReview> {
  const prompt = loadPrompt('factpack-review')
  const result = await callModel({
    purpose: 'factpack_review',
    role: 'helper',
    system: [{ text: prompt.body }],
    messages: [
      {
        role: 'user',
        content: `${dataBlock('fact_pack', JSON.stringify(pack))}\n\nReturn the review JSON.`,
      },
    ],
    maxTokens: 1_500,
    schema: FactPackReview,
    factPackId: opts.factPackId ?? null,
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  if (!result.data) {
    // Fail closed: an unreadable review is not an endorsement.
    return {
      accept: false,
      quality_score: 0,
      reasons: ['review output did not validate'],
    }
  }
  return result.data
}

/** Both passes. Deterministic first and free; a deterministic failure skips the model. */
export async function reviewFactPack(
  candidate: unknown,
  opts: ModelReviewOptions = {},
): Promise<{ deterministic: DeterministicReview; model: FactPackReview }> {
  const deterministic = reviewFactPackDeterministic(candidate)
  if (!deterministic.accept || !deterministic.pack) {
    return {
      deterministic,
      model: { accept: false, quality_score: 0, reasons: deterministic.reasons },
    }
  }
  const model = await reviewFactPackWithModel(deterministic.pack, opts)
  return { deterministic, model }
}
