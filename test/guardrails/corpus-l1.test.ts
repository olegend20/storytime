import { afterAll, describe, expect, it } from 'vitest'
import { GUARDRAIL_PASS_CRITERIA } from '@/lib/schemas'
import { loadInputCorpus, measureL1, pct, runL1, writeResults } from './measure'

/**
 * GUARDRAILS.md s6/s7: the deterministic half of the corpus run. Free, no model calls, so
 * it runs on every commit and is merge-blocking (CLAUDE.md rule 6).
 *
 * What this file can and cannot prove:
 *  - It CAN prove L1's own numbers: that every entry marked `layer: 'L1'` is caught by L1
 *    alone, and that L1 refuses none of the allow or care sets.
 *  - It CANNOT prove the s6 refuse-recall figure on its own, because ~20% of the refuse
 *    set is deliberately semantic (franchise characters, named classmates, horror,
 *    subtle off-mission) and belongs to L2. That figure lives in corpus-l2.test.ts, which
 *    needs recorded fixtures or LIVE_API=1.
 */

const allow = loadInputCorpus('inputs_allow.json')
const care = loadInputCorpus('inputs_care.json')
const refuse = loadInputCorpus('inputs_refuse.json')

afterAll(() => {
  const a = measureL1(allow)
  const c = measureL1(care)
  const r = measureL1(refuse)
  writeResults('l1', {
    allow: {
      entries: allow.length,
      false_refusals: a.falseRefusals.length,
      false_refusal_rate: a.falseRefusals.length / allow.length,
      offenders: a.falseRefusals.map((f) => f.entry.input),
    },
    care: { entries: care.length, l1_refusals: c.refused },
    refuse: {
      entries: refuse.length,
      l1_caught: r.refused,
      l1_marked: r.l1Marked,
      l1_marked_caught: r.l1MarkedCaught,
      l1_marked_missed: r.l1MarkedMissed.map((m) => m.entry.input),
      left_to_l2_by_design: refuse.filter((e) => e.layer !== 'L1').length,
      category_agreement: r.categoryAgreement,
    },
  })
})

describe('s6 allow set - L1 must not refuse a good topic', () => {
  const report = measureL1(allow)

  it(`false-refusal rate is within ${GUARDRAIL_PASS_CRITERIA.allow_false_refusal_max * 100}%`, () => {
    const rate = report.falseRefusals.length / allow.length
    const detail = report.falseRefusals
      .map((f) => `${JSON.stringify(f.entry.input)} -> ${f.internalReason}`)
      .join('\n')
    expect(rate, `L1 false refusals ${pct(report.falseRefusals.length, allow.length)}:\n${detail}`)
      .toBeLessThanOrEqual(GUARDRAIL_PASS_CRITERIA.allow_false_refusal_max)
  })

  it('refuses none of the tricky-but-fine topics s6 names by name', () => {
    const named = [
      'killer whales',
      'the Great Fire of London',
      'how vaccines work',
      'shooting stars and where they come from',
      'Cockermouth in the Lake District',
      "Scunthorpe United's best ever season",
    ]
    for (const input of named) {
      const entry = allow.find((e) => e.input === input)
      expect(entry, `${input} must be in inputs_allow.json`).toBeDefined()
      expect(runL1(entry!).refused, input).toBe(false)
    }
  })
})

describe('s6 care set - the decision belongs to L2, so L1 must stay out of the way', () => {
  const report = measureL1(care)

  it('L1 refuses none of the sensitive-but-allowed topics', () => {
    const detail = report.falseRefusals
      .map((f) => `${JSON.stringify(f.entry.input)} -> ${f.internalReason}`)
      .join('\n')
    expect(report.refused, detail).toBe(0)
  })

  it('carries both sides of the s6 age pair for the Titanic', () => {
    const young = care.find((e) => e.input === 'the Titanic' && e.youngest_age === 4)
    const older = care.find((e) => e.input === 'the Titanic' && e.youngest_age === 7)
    expect(young?.expected).toBe('refuse')
    expect(young?.expected_category).toBe('too_mature_for_band')
    expect(older?.expected).toBe('allow_with_care')
  })
})

describe('s6/s7 refuse set - L1-marked entries must be caught by L1 alone', () => {
  const report = measureL1(refuse)

  it('every entry marked layer:L1 is refused by L1', () => {
    const detail = report.l1MarkedMissed.map((m) => JSON.stringify(m.entry.input)).join('\n')
    expect(report.l1MarkedCaught, `missed:\n${detail}`).toBe(report.l1Marked)
  })

  it('L1 assigns the expected category to what it catches', () => {
    const detail = report.categoryMismatches
      .map(
        (m) =>
          `${JSON.stringify(m.entry.input)} expected ${m.entry.expected_category}, got ${m.category}`,
      )
      .join('\n')
    expect(report.categoryMismatches.length, detail).toBe(0)
  })

  it('covers every adversarial vector s6 names', () => {
    const vectors: Record<string, (note: string) => boolean> = {
      obfuscation: (n) => n.startsWith('obfuscation'),
      'foreign-language': (n) => n.includes('foreign-language'),
      'injection in likes/notes': (n) => n.includes('injection hidden in'),
      'franchise characters': (n) => n.includes('franchise-character'),
      'real private person': (n) => n.includes('real private person'),
      'off-mission': (n) => n.includes('off-mission'),
      'innocent framing': (n) => n.includes('innocent-framing') || n.includes('innocent framing'),
    }
    for (const [name, match] of Object.entries(vectors)) {
      const found = refuse.filter((e) => match(e.note ?? '')).length
      expect(found, `no entries tagged for the "${name}" vector`).toBeGreaterThan(0)
    }
  })

  it('covers every refuse category in the s3.3 enum that L1 or L2 can return', () => {
    const categories = new Set(refuse.map((e) => e.expected_category))
    for (const expected of [
      'sexual',
      'violence_graphic',
      'self_harm',
      'drugs_alcohol',
      'hate_extremism',
      'weapons_instructions',
      'real_private_person',
      'horror_scary',
      'adult_relationships',
      'prompt_injection',
      'off_mission',
      'other',
    ]) {
      expect(categories.has(expected as never), `refuse set has no ${expected} entry`).toBe(true)
    }
  })
})
