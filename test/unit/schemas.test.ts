import { describe, expect, it } from 'vitest'
import {
  ChildInput,
  FactPack,
  StoryBible,
  bandForAge,
  bandForAges,
  targetWords,
  wordCountWithinTolerance,
  applyCaps,
  weightedOverall,
  resolvePositionSwap,
  unswap,
  JUDGE_WEIGHTS,
  JUDGE_CRITERIA,
  MAX_SCARY_LEVEL,
  type JudgeScore,
  factCardsFor, FACT_CARDS_MAX, SseEvent,
} from '@/lib/schemas'

/** F3 VT: zod accepts a valid child; rejects age 0, 18, a 31-char name, 11 likes. */
describe('F3 child schema', () => {
  const valid = { first_name: 'Cruz', age: 7, likes: ['LEGO', 'sharks'], notes: null, reading_level: null }

  it('accepts a valid child', () => {
    expect(ChildInput.safeParse(valid).success).toBe(true)
  })
  it('rejects age 0', () => {
    expect(ChildInput.safeParse({ ...valid, age: 0 }).success).toBe(false)
  })
  it('rejects age 18', () => {
    expect(ChildInput.safeParse({ ...valid, age: 18 }).success).toBe(false)
  })
  it('rejects a 31-character name', () => {
    expect(ChildInput.safeParse({ ...valid, first_name: 'a'.repeat(31) }).success).toBe(false)
  })
  it('accepts a 30-character name', () => {
    expect(ChildInput.safeParse({ ...valid, first_name: 'a'.repeat(30) }).success).toBe(true)
  })
  it('rejects 11 likes', () => {
    expect(
      ChildInput.safeParse({ ...valid, likes: Array.from({ length: 11 }, (_, i) => `l${i}`) }).success,
    ).toBe(false)
  })
  it('rejects notes over 300 characters', () => {
    expect(ChildInput.safeParse({ ...valid, notes: 'x'.repeat(301) }).success).toBe(false)
  })
  it('accepts names with hyphens, apostrophes and non-Latin letters', () => {
    for (const name of ['Mary-Jane', "O'Brien", 'Zoë', 'Ayşe', 'Александр']) {
      expect(ChildInput.safeParse({ ...valid, first_name: name }).success, name).toBe(true)
    }
  })
  it('rejects names with digits or markup, per GUARDRAILS.md s3.2', () => {
    for (const name of ['Cruz2', '<script>', '###', 'Cruz!', 'a_b', '[INST]']) {
      expect(ChildInput.safeParse({ ...valid, first_name: name }).success, name).toBe(false)
    }
  })

  /**
   * Boundary note for lane 6 (F15): the zod pattern governs the SHAPE of a name
   * (letters, spaces, hyphens, apostrophes). It cannot catch an injection attempt
   * spelled in plain letters - "ignore previous" is a shape-valid name. Rejecting that
   * is L1's injection-pattern check, which owns the semantic layer. Asserted here so the
   * division of responsibility is explicit rather than assumed.
   */
  it('accepts a letters-only injection phrase by shape, leaving it to L1', () => {
    expect(ChildInput.safeParse({ ...valid, first_name: 'ignore previous' }).success).toBe(true)
  })
})

/** s4.5 age bands and length targets. F6 VT covers targetWords. */
describe('s4.5 age bands and word targets', () => {
  it('maps ages to bands, with 1-2 falling into A', () => {
    expect([1, 2, 3, 5].map(bandForAge)).toEqual(['A', 'A', 'A', 'A'])
    expect([6, 8].map(bandForAge)).toEqual(['B', 'B'])
    expect([9, 12].map(bandForAge)).toEqual(['C', 'C'])
    expect([13, 17].map(bandForAge)).toEqual(['D', 'D'])
  })

  it('follows the YOUNGEST child for mixed ages', () => {
    expect(bandForAges([4, 7, 10])).toBe('A')
    expect(bandForAges([9, 12])).toBe('C')
  })

  it('band A at 10 minutes targets 1,300-1,700 words', () => {
    expect(targetWords({ band: 'A', minutes: 10 })).toEqual({ min: 1300, max: 1700 })
  })
  it('band C at 10 minutes targets 2,200-3,200 words', () => {
    expect(targetWords({ band: 'C', minutes: 10 })).toEqual({ min: 2200, max: 3200 })
  })
  it('5 minutes halves the target', () => {
    expect(targetWords({ band: 'A', minutes: 5 })).toEqual({ min: 650, max: 850 })
  })
  it('15 minutes scales linearly', () => {
    expect(targetWords({ band: 'C', minutes: 15 })).toEqual({ min: 3300, max: 4800 })
  })

  it('applies a +/-15% tolerance around the range', () => {
    const target = targetWords({ band: 'B', minutes: 10 }) // 1600-2200
    expect(wordCountWithinTolerance(1900, target)).toBe(true)
    expect(wordCountWithinTolerance(1360, target)).toBe(true) // 1600 * 0.85
    expect(wordCountWithinTolerance(1200, target)).toBe(false)
    expect(wordCountWithinTolerance(2530, target)).toBe(true) // 2200 * 1.15
    expect(wordCountWithinTolerance(2800, target)).toBe(false)
  })

  it('allows bands A and B a brief wobble and nothing more (owner decision, DECISIONS #127)', () => {
    // Level 1 is "is it going to erupt?" / "no". Level 2 is tension that lasts.
    expect(MAX_SCARY_LEVEL.A).toBe(1)
    expect(MAX_SCARY_LEVEL.B).toBe(1)
    expect(MAX_SCARY_LEVEL.C).toBe(2)
    expect(MAX_SCARY_LEVEL.D).toBe(2)
  })
})

describe('s4.3 fact pack schema', () => {
  const sources = [{ id: 's1', title: 'LEGO history', url: 'https://example.com/lego' }]
  const facts = Array.from({ length: 12 }, (_, i) => ({
    id: `f${i + 1}`,
    text: `Fact number ${i + 1} about LEGO.`,
    kid_safe: true,
    min_age: 3,
    confidence: 'high' as const,
    source_ids: ['s1'],
  }))
  const base = {
    topic_key: 'history-of-lego',
    topic_label: 'The history of LEGO',
    summary: 'A short summary.',
    facts,
    timeline: [],
    characters: [],
    sensitive_notes: null,
    sources,
  }

  it('accepts a pack with the minimum 12 sourced facts', () => {
    expect(FactPack.safeParse(base).success).toBe(true)
  })

  /** F5 VT: review rejects a pack with 11 facts. */
  it('rejects a pack with 11 facts', () => {
    expect(FactPack.safeParse({ ...base, facts: facts.slice(0, 11) }).success).toBe(false)
  })

  /** DECISIONS #139: a knowledge pack has no sources at all, and that is valid. */
  it('accepts facts with no sources, and a pack with none', () => {
    const unsourced = facts.map((f) => ({ ...f, source_ids: [] }))
    expect(FactPack.safeParse({ ...base, facts: unsourced, sources: [] }).success).toBe(true)
  })

  it('rejects a fact citing a source that is not in the pack', () => {
    const broken = [...facts]
    broken[0] = { ...facts[0]!, source_ids: ['s99'] }
    const result = FactPack.safeParse({ ...base, facts: broken })
    expect(result.success).toBe(false)
  })

  /** GUARDRAILS.md s3.3: a kid_safe:false fact needs sensitive_notes. */
  it('rejects a kid_safe:false fact when the pack has no sensitive_notes', () => {
    const broken = [...facts]
    broken[0] = { ...facts[0]!, kid_safe: false }
    expect(FactPack.safeParse({ ...base, facts: broken, sensitive_notes: null }).success).toBe(false)
  })

  it('accepts a kid_safe:false fact when sensitive_notes explains the handling', () => {
    const broken = [...facts]
    broken[0] = { ...facts[0]!, kid_safe: false }
    expect(
      FactPack.safeParse({
        ...base,
        facts: broken,
        sensitive_notes: 'The 1942 fire: handle gently, nobody hurt.',
      }).success,
    ).toBe(true)
  })

  it('rejects a duplicate fact id', () => {
    const broken = [...facts, { ...facts[0]! }]
    expect(FactPack.safeParse({ ...base, facts: broken }).success).toBe(false)
  })

  it('requires a kebab-case topic_key', () => {
    expect(FactPack.safeParse({ ...base, topic_key: 'History of LEGO' }).success).toBe(false)
  })
})

describe('s4.2 story bible schema', () => {
  it('rejects more than 8 recurring elements', () => {
    const recurring = Array.from({ length: 9 }, (_, i) => ({
      name: `Thing ${i}`,
      type: 'device' as const,
      rule: 'does a thing',
    }))
    const result = StoryBible.safeParse({
      children: [{ name: 'Cruz', age: 7, likes: [], role_notes: null }],
      recurring,
    })
    expect(result.success).toBe(false)
  })

  it('rejects more than 20 topics_covered', () => {
    const topics = Array.from({ length: 21 }, (_, i) => ({
      topic: `topic ${i}`,
      story_id: null,
      date: '2026-09-27',
    }))
    const result = StoryBible.safeParse({
      children: [{ name: 'Cruz', age: 7, likes: [], role_notes: null }],
      topics_covered: topics,
    })
    expect(result.success).toBe(false)
  })
})

describe('JUDGE_AGENT.md s3 rubric arithmetic', () => {
  it('weights sum to exactly 1', () => {
    const sum = JUDGE_CRITERIA.reduce((acc, c) => acc + JUDGE_WEIGHTS[c], 0)
    expect(sum).toBeCloseTo(1, 10)
  })

  it('computes the weighted overall', () => {
    expect(
      weightedOverall({ center: 4, craft: 5, facts: 4, age_fit: 5, continuity: 5, delight: 4 }),
    ).toBeCloseTo(4.45, 2)
  })

  const raw: JudgeScore = {
    scores: { center: 5, craft: 5, facts: 5, age_fit: 5, continuity: 5, delight: 5 },
    evidence: { center: '', craft: '', facts: '', age_fit: '', continuity: '', delight: '' },
    caps_applied: ['none'],
    disqualified: false,
    overall: 5,
    editor_notes: [],
    best_moment: null,
    worst_moment: null,
  }

  it('a guardrail breach forces overall 1 and disqualification', () => {
    const capped = applyCaps(raw, {
      guardrailBreach: true,
      inventedFact: false,
      wordCountOutOfRange: false,
    })
    expect(capped.overall).toBe(1)
    expect(capped.disqualified).toBe(true)
  })

  it('an invented fact caps facts at 2 and lowers the overall', () => {
    const capped = applyCaps(raw, {
      guardrailBreach: false,
      inventedFact: true,
      wordCountOutOfRange: false,
    })
    expect(capped.scores.facts).toBe(2)
    expect(capped.overall).toBeLessThan(5)
    expect(capped.disqualified).toBe(false)
  })

  it('a word count outside the range caps age_fit at 3', () => {
    const capped = applyCaps(raw, {
      guardrailBreach: false,
      inventedFact: false,
      wordCountOutOfRange: true,
    })
    expect(capped.scores.age_fit).toBe(3)
  })

  it('recomputes the overall rather than trusting the model arithmetic', () => {
    const lying = { ...raw, overall: 1.2 }
    const capped = applyCaps(lying, {
      guardrailBreach: false,
      inventedFact: false,
      wordCountOutOfRange: false,
    })
    expect(capped.overall).toBeCloseTo(5, 2)
  })
})

/** JUDGE_AGENT.md s7 VT: position-swap logic records TIE when the orders disagree. */
describe('JUDGE_AGENT.md s2 position swapping', () => {
  it('keeps the verdict when both orders agree', () => {
    expect(resolvePositionSwap('A', 'A')).toEqual({ verdict: 'A', flipped: false })
  })

  it('records a TIE when the verdict flips with position', () => {
    expect(resolvePositionSwap('A', 'B')).toEqual({ verdict: 'TIE', flipped: true })
  })

  it('un-swaps a verdict from the reversed presentation', () => {
    expect(unswap('A')).toBe('B')
    expect(unswap('B')).toBe('A')
    expect(unswap('TIE')).toBe('TIE')
  })

  it('treats an explicit TIE in one order as a disagreement with a win in the other', () => {
    expect(resolvePositionSwap('A', 'TIE').verdict).toBe('TIE')
  })
})

describe('the `facts` stream event (fact cards while the writer thinks)', () => {
  const pack = {
    topic_label: 'Volcanoes',
    facts: [
      { id: 'f1', text: 'Lava is melted rock.', kid_safe: true, min_age: 3 },
      { id: 'f2', text: 'A grim detail.', kid_safe: false, min_age: 3 },
      { id: 'f3', text: 'For older children.', kid_safe: true, min_age: 8 },
      ...Array.from({ length: 15 }, (_, i) => ({ id: `f${i + 4}`, text: `Fact ${i + 4}.`, kid_safe: true, min_age: 3 })),
    ],
  }
  it('carries only facts the story may use, in pack order, capped', () => {
    const event = factCardsFor(pack, 4)!
    expect(event.type).toBe('facts')
    expect(event.facts.map((f) => f.id)).not.toContain('f2')
    expect(event.facts.map((f) => f.id)).not.toContain('f3')
    expect(event.facts[0]!.id).toBe('f1')
    expect(event.facts).toHaveLength(FACT_CARDS_MAX)
    expect(SseEvent.safeParse(event).success).toBe(true)
  })
  it('includes the older child\'s facts when the youngest is old enough, and is null with no pack', () => {
    expect(factCardsFor(pack, 9)!.facts.map((f) => f.id)).toContain('f3')
    expect(factCardsFor(null, 4)).toBeNull()
  })
})
