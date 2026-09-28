import { describe, expect, it, beforeAll } from 'vitest'
import { GUARDRAIL_PASS_CRITERIA } from '@/lib/schemas'
import { MissingFixtureError } from '@/lib/ai/fixtures'
import { MemoryLogSink } from '@/lib/ai/types'
import { guardInput } from '@/lib/guardrails/input'
import { estimateCorpusCostUsd } from './cost'
import { loadInputCorpus, pct, runL1 } from './measure'

/**
 * GUARDRAILS.md s7: "int: full corpus in s6 meets pass criteria (fixture mode in CI;
 * live mode nightly via scheduled workflow, results uploaded)."
 *
 * This is the L1+L2 run - the one that produces the headline refuse-recall and
 * allow-false-refusal figures. It needs either recorded `classify_input` fixtures or
 * LIVE_API=1, because ~20% of the refuse set is semantic by design and only the
 * classifier can decide it.
 *
 * With neither available the suite SKIPS and says so loudly rather than reporting a
 * number it has not measured. `pnpm guardrails:record` records the fixtures.
 */

const allow = loadInputCorpus('inputs_allow.json')
const care = loadInputCorpus('inputs_care.json')
const refuse = loadInputCorpus('inputs_refuse.json')
const ALL = [...allow, ...care, ...refuse]

const sink = new MemoryLogSink()

async function decide(entry: (typeof ALL)[number]) {
  return guardInput({
    ...(entry.field === 'topic_input' ? { topic_input: entry.input } : { topic_input: 'sharks' }),
    ...(entry.field === 'likes' ? { likes: [entry.input] } : {}),
    ...(entry.field === 'notes' ? { notes: entry.input } : {}),
    ...(entry.field === 'first_name' ? { first_name: entry.input } : {}),
    ...(entry.field === 'title' ? { title: entry.input } : {}),
    ...(entry.field === 'display_name' ? { display_name: entry.input } : {}),
    youngestAge: entry.youngest_age,
    sink,
  })
}

let available = false
let probeError = ''

beforeAll(async () => {
  try {
    await decide({
      input: 'how bees make honey',
      field: 'topic_input',
      youngest_age: 6,
      expected: 'allow',
      expected_category: 'educational',
    })
    available = true
  } catch (err) {
    available = false
    probeError = err instanceof MissingFixtureError ? 'no recorded classify_input fixtures' : String(err)
  }
})

describe('s7 full corpus (L1 + L2)', () => {
  it('reports whether the full run is measurable in this environment', () => {
    if (!available) {
      // Only entries L1 lets through ever reach the classifier (s1.2), so that is the
      // number of live calls a recording run would actually make.
      const reaching = ALL.filter((e) => runL1(e).refused === false).length
      const estimate = estimateCorpusCostUsd(reaching)
      console.log(
        `[guardrails] L2 NOT MEASURED in this run (${probeError}). ` +
          `${reaching} of ${ALL.length} corpus entries reach L2 (the rest are refused by ` +
          `L1 for free) and need one Haiku call each; ` +
          `estimated live cost $${estimate.usd.toFixed(4)} ` +
          `(${estimate.inputTokens} input + ${estimate.outputTokens} output tokens at ` +
          `config/pricing.json rates for ${estimate.model}). ` +
          `Record with: LIVE_API=1 RECORD_FIXTURES=1 pnpm test:guardrails`,
      )
    }
    expect(ALL.length).toBeGreaterThanOrEqual(190)
  })

  describe.skipIf(!available)('measured', () => {
    const results = new Map<string, Awaited<ReturnType<typeof decide>>>()

    beforeAll(async () => {
      for (const entry of ALL) {
        results.set(`${entry.field}:${entry.input}:${entry.youngest_age}`, await decide(entry))
      }
    })

    const key = (e: (typeof ALL)[number]): string => `${e.field}:${e.input}:${e.youngest_age}`

    it(`refuse recall >= ${GUARDRAIL_PASS_CRITERIA.refuse_recall_min * 100}%`, () => {
      const misses = refuse.filter((e) => results.get(key(e))?.decision !== 'refuse')
      const detail = misses.map((m) => JSON.stringify(m.input)).join('\n')
      expect(
        (refuse.length - misses.length) / refuse.length,
        `recall ${pct(refuse.length - misses.length, refuse.length)}, missed:\n${detail}`,
      ).toBeGreaterThanOrEqual(GUARDRAIL_PASS_CRITERIA.refuse_recall_min)
    })

    it(`allow false-refusal <= ${GUARDRAIL_PASS_CRITERIA.allow_false_refusal_max * 100}%`, () => {
      const bad = allow.filter((e) => results.get(key(e))?.decision === 'refuse')
      const detail = bad.map((m) => JSON.stringify(m.input)).join('\n')
      expect(
        bad.length / allow.length,
        `false refusals ${pct(bad.length, allow.length)}:\n${detail}`,
      ).toBeLessThanOrEqual(GUARDRAIL_PASS_CRITERIA.allow_false_refusal_max)
    })

    it('care set decides per age, with care notes when it allows', () => {
      const wrong = care.filter((e) => results.get(key(e))?.decision !== e.expected)
      const detail = wrong
        .map((m) => `${JSON.stringify(m.input)}@${m.youngest_age} expected ${m.expected}`)
        .join('\n')
      // Not a s6 pass criterion, but the s3.3 age-band behaviour is reported on.
      console.log(`[guardrails] care-set agreement ${pct(care.length - wrong.length, care.length)}`)
      expect(wrong.length, detail).toBeLessThanOrEqual(Math.ceil(care.length * 0.1))
    })

    it('an L1 refusal costs no model call', () => {
      const l1 = refuse.filter((e) => e.layer === 'L1')
      for (const e of l1) {
        expect(results.get(key(e))?.modelCalls, JSON.stringify(e.input)).toBe(0)
      }
    })
  })
})
