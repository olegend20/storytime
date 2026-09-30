import { describe, expect, it } from 'vitest'
import {
  reviewFactPackDeterministic,
  trimFactPackToBudget,
  slugifyTopicKey,
  parseNormalization,
  webSearchTool,
  extractFinalJson,
  sourcesOf,
  WebSearchUnsupportedError,
  FACT_PACK_MAX_SEARCHES,
} from '@/lib/topics'
import { FACT_PACK_TOKEN_LIMIT } from '@/lib/schemas'
import { goodFactPack } from '../helpers/story'

/** F5 - normalization repair and the deterministic half of the fact-pack review. */

describe('F5 VT: the review pass rejects a bad pack, for free', () => {
  it('rejects a pack with 11 facts and names the count', () => {
    const pack = goodFactPack()
    const candidate = { ...pack, facts: pack.facts.slice(0, 11) }
    const review = reviewFactPackDeterministic(candidate)
    expect(review.accept).toBe(false)
    expect(review.reasons).toContain('too_few_facts:11')
    // No model call is possible from a rejected pack: there is nothing to review.
    expect(review.pack).toBeNull()
  })

  it('rejects a fact with empty source_ids and names the fact', () => {
    const pack = goodFactPack()
    const candidate = structuredClone(pack) as typeof pack
    candidate.facts[2]!.source_ids = []
    const review = reviewFactPackDeterministic(candidate)
    expect(review.accept).toBe(false)
    expect(review.reasons).toContain('fact_without_source:f3')
  })

  it('rejects a fact citing a source that is not in the pack', () => {
    const candidate = structuredClone(goodFactPack())
    candidate.facts[0]!.source_ids = ['s9']
    expect(reviewFactPackDeterministic(candidate).reasons).toContain('fact_unknown_source:f1')
  })

  it('rejects a fact with no confidence', () => {
    const candidate = structuredClone(goodFactPack()) as unknown as {
      facts: Record<string, unknown>[]
    }
    delete candidate.facts[5]!.confidence
    expect(reviewFactPackDeterministic(candidate).reasons).toContain('fact_without_confidence:f6')
  })

  it('rejects a kid_safe:false fact with no sensitive_notes', () => {
    const candidate = structuredClone(goodFactPack())
    candidate.facts[1]!.kid_safe = false
    candidate.sensitive_notes = null
    expect(reviewFactPackDeterministic(candidate).reasons).toContain('missing_sensitive_notes')
  })

  it('accepts the same pack once sensitive_notes explains the handling', () => {
    const candidate = structuredClone(goodFactPack())
    candidate.facts[1]!.kid_safe = false
    candidate.sensitive_notes = 'The 1942 fire: handle gently, nobody was hurt.'
    expect(reviewFactPackDeterministic(candidate).accept).toBe(true)
  })

  it('rejects a pack over the 2,000-token cap', () => {
    const candidate = structuredClone(goodFactPack())
    candidate.summary = 'x '.repeat(3000)
    const review = reviewFactPackDeterministic(candidate)
    expect(review.accept).toBe(false)
    expect(review.reasons.join()).toMatch(/pack_too_large:\d+/)
    expect(review.tokenEstimate).toBeGreaterThan(FACT_PACK_TOKEN_LIMIT)
  })

  it('rejects a non-kebab-case topic_key', () => {
    const candidate = { ...structuredClone(goodFactPack()), topic_key: 'History of LEGO' }
    expect(reviewFactPackDeterministic(candidate).reasons).toContain('bad_topic_key')
  })

  it('rejects a duplicate fact id', () => {
    const candidate = structuredClone(goodFactPack())
    candidate.facts[3]!.id = candidate.facts[2]!.id
    expect(reviewFactPackDeterministic(candidate).reasons).toContain('duplicate_fact_id:f3')
  })

  it('rejects unparseable input rather than throwing', () => {
    expect(reviewFactPackDeterministic(null).reasons).toEqual(['unparseable'])
    expect(reviewFactPackDeterministic('not a pack').reasons).toEqual(['unparseable'])
  })

  it('accepts a good pack and hands back the validated object', () => {
    const review = reviewFactPackDeterministic(goodFactPack())
    expect(review.accept).toBe(true)
    expect(review.reasons).toEqual([])
    expect(review.pack?.topic_key).toBe('history-of-lego')
  })
})

describe('F5: an over-budget pack is trimmed from the end, not thrown away', () => {
  /** 40 one-sentence facts, each citing its own source: realistic shape, well over 2,000. */
  const oversized = () => {
    const pack = structuredClone(goodFactPack())
    pack.facts = Array.from({ length: 40 }, (_, i) => ({
      ...pack.facts[0]!,
      id: `f${i + 1}`,
      text: `Fact number ${i + 1} is one plain sentence of roughly the length a real one runs to.`,
      source_ids: [`s${i + 1}`],
    }))
    pack.sources = pack.facts.map((_, i) => ({
      id: `s${i + 1}`,
      title: `Source ${i + 1}`,
      url: `https://example.com/source/${i + 1}`,
    }))
    return pack
  }

  it('leaves a pack that fits exactly as it was', () => {
    const pack = goodFactPack()
    const { candidate, dropped } = trimFactPackToBudget(pack)
    expect(dropped).toBe(0)
    expect(candidate).toBe(pack)
  })

  it('drops facts from the end until review accepts it, and prunes orphaned sources', () => {
    const pack = oversized()
    expect(reviewFactPackDeterministic(pack).reasons.join()).toMatch(/pack_too_large/)

    const { candidate, dropped } = trimFactPackToBudget(pack)
    const review = reviewFactPackDeterministic(candidate)
    expect(dropped).toBeGreaterThan(0)
    expect(review.accept).toBe(true)
    expect(review.tokenEstimate).toBeLessThanOrEqual(FACT_PACK_TOKEN_LIMIT)
    // A prefix: the model was told the last facts are the ones it would miss least.
    const kept = review.pack!.facts
    expect(kept.map((f) => f.id)).toEqual(pack.facts.slice(0, kept.length).map((f) => f.id))
    expect(review.pack!.sources.map((s) => s.id)).toEqual(kept.map((f) => f.source_ids[0]))
  })

  it('stops at the fact floor and lets review reject what still does not fit', () => {
    const pack = structuredClone(goodFactPack())
    pack.summary = 'x '.repeat(3000)
    const { candidate } = trimFactPackToBudget(pack)
    expect((candidate as typeof pack).facts).toHaveLength(12)
    expect(reviewFactPackDeterministic(candidate).reasons.join()).toMatch(/pack_too_large:\d+/)
  })

  it('does not touch input it cannot safely edit', () => {
    expect(trimFactPackToBudget(null)).toEqual({ candidate: null, dropped: 0 })
    const noFacts = { summary: 'x '.repeat(3000) }
    expect(trimFactPackToBudget(noFacts).candidate).toBe(noFacts)
  })
})

describe('F5: topic_key slugification', () => {
  it('forces kebab-case', () => {
    expect(slugifyTopicKey('History of LEGO')).toBe('history-of-lego')
    expect(slugifyTopicKey('  The Titanic!  ')).toBe('the-titanic')
    expect(slugifyTopicKey('history--of___lego')).toBe('history-of-lego')
    expect(slugifyTopicKey('Pokémon')).toBe('pokemon')
  })

  it('returns an empty string for input with no usable characters', () => {
    expect(slugifyTopicKey('!!!')).toBe('')
  })
})

describe('F5: normalization output repair', () => {
  it('repairs a key the model returned in the wrong case', () => {
    const parsed = parseNormalization(
      '{"topic_key":"History-Of-LEGO","topic_label":"The history of LEGO","is_appropriate_for_children":true,"reason":"educational"}',
    )
    expect(parsed?.topic_key).toBe('history-of-lego')
  })

  it('handles a fenced response', () => {
    const parsed = parseNormalization(
      '```json\n{"topic_key":"sharks","topic_label":"Sharks","is_appropriate_for_children":true,"reason":"nature"}\n```',
    )
    expect(parsed?.topic_key).toBe('sharks')
  })

  it('treats a missing or non-boolean verdict as NOT appropriate', () => {
    const parsed = parseNormalization('{"topic_key":"sharks","topic_label":"Sharks"}')
    expect(parsed?.is_appropriate_for_children).toBe(false)
    const stringy = parseNormalization(
      '{"topic_key":"sharks","topic_label":"Sharks","is_appropriate_for_children":"yes"}',
    )
    expect(stringy?.is_appropriate_for_children).toBe(false)
  })

  it('falls back to the key when the label is missing', () => {
    const parsed = parseNormalization(
      '{"topic_key":"history-of-soccer","is_appropriate_for_children":true}',
    )
    expect(parsed?.topic_label).toBe('history of soccer')
  })

  it('returns null when there is no usable key', () => {
    expect(parseNormalization('not json at all')).toBeNull()
    expect(parseNormalization('{"topic_label":"Sharks"}')).toBeNull()
  })
})

describe('F5: the web-search tool comes from config, not from source', () => {
  it('builds the tool for the configured factpack model', () => {
    const tool = webSearchTool('claude-sonnet-5') as unknown as Record<string, unknown>
    expect(tool.type).toBe('web_search_20260209')
    expect(tool.name).toBe('web_search')
    // One search per research call; the calls run in parallel, one angle each.
    expect(tool.max_uses).toBe(1)
    expect(FACT_PACK_MAX_SEARCHES).toBe(4)
  })

  it('refuses a model that config says cannot search (Haiku 4.5)', () => {
    expect(() => webSearchTool('claude-haiku-4-5-20251001')).toThrow(WebSearchUnsupportedError)
  })
})

describe('F5: extracting the pack JSON from a web-search response', () => {
  it('prefers the last text block, so search narration is not spliced in', () => {
    const raw = {
      content: [
        { type: 'text', text: 'Let me search for { this } first.' },
        { type: 'web_search_tool_result', content: [{ title: 'x' }] },
        { type: 'text', text: '{"topic_key":"sharks","facts":[]}' },
      ],
    }
    expect(extractFinalJson(raw, 'ignored')).toEqual({ topic_key: 'sharks', facts: [] })
  })

  it('falls back to the joined text when there are no content blocks', () => {
    expect(extractFinalJson(null, '{"topic_key":"sharks"}')).toEqual({ topic_key: 'sharks' })
  })

  it('pulls out only well-formed sources', () => {
    expect(
      sourcesOf({
        sources: [
          { id: 's1', title: 'A page', url: 'https://example.com' },
          { id: 's2', title: 'no url' },
          'nonsense',
        ],
      }),
    ).toEqual([{ id: 's1', title: 'A page', url: 'https://example.com' }])
  })
})
