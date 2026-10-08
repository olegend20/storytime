import { afterAll, describe, expect, it } from 'vitest'
import { GUARDRAIL_PASS_CRITERIA, HARD_RULE_MAX, HARD_RULE_MIN } from '@/lib/schemas'
import { loadOutputCorpus, measureOutput, pct, writeResults } from './measure'

/**
 * GUARDRAILS.md s6: "outputs_violations.json - >= 40 synthetic story excerpts, each
 * breaching exactly one hard rule (1-14), plus 20 clean excerpts that contain allowlisted
 * words. Expected: every breach caught with the right rule number; no clean excerpt
 * flagged."
 *
 * Pass criteria: output-violations recall 100% for hard rules; clean-set false positives 0.
 *
 * Honest note on what this measures: the excerpts and the deterministic patterns were
 * authored by the same lane, so a 100% here is a regression guard, not evidence that the
 * gate catches breaches it has never seen. The independent check is
 * test/unit/guardrail-references.test.ts, which runs the same scanner over the four
 * reference stories - prose this lane did not write - and requires zero hard violations.
 */

const corpus = loadOutputCorpus()
const report = measureOutput(corpus)

afterAll(() => {
  writeResults('output-deterministic', {
    breaching: report.breaching,
    breaching_caught: report.breachingCaught,
    hard_rule_recall: report.breachingCaught / report.breaching,
    missed: report.missed.map((m) => ({ rule: m.entry.expected_rule, excerpt: m.entry.excerpt })),
    clean: report.clean,
    clean_false_positives: report.cleanFalsePositives.length,
    over_firing: report.overFiring.length,
    per_rule: report.perRule,
  })
})

describe('s6 output corpus shape', () => {
  it('has at least 40 breaching excerpts and 20 clean ones', () => {
    expect(report.breaching).toBeGreaterThanOrEqual(40)
    expect(report.clean).toBeGreaterThanOrEqual(20)
  })

  it('covers every hard rule 1-14 with at least one breaching excerpt (rule 7 retired 2026-10-08)', () => {
    for (let rule = HARD_RULE_MIN; rule <= HARD_RULE_MAX; rule += 1) {
      if (rule === 7) continue
      expect(report.perRule[rule]?.total ?? 0, `no excerpt breaches rule ${rule}`).toBeGreaterThan(0)
    }
  })
})

describe('s6 output pass criteria', () => {
  it(`hard-rule recall is ${GUARDRAIL_PASS_CRITERIA.output_hard_rule_recall_min * 100}%`, () => {
    const detail = report.missed
      .map((m) => `rule ${m.entry.expected_rule}: ${m.entry.excerpt.slice(0, 100)}`)
      .join('\n')
    expect(
      report.breachingCaught / report.breaching,
      `recall ${pct(report.breachingCaught, report.breaching)}, missed:\n${detail}`,
    ).toBeGreaterThanOrEqual(GUARDRAIL_PASS_CRITERIA.output_hard_rule_recall_min)
  })

  it('flags no clean excerpt', () => {
    const detail = report.cleanFalsePositives
      .map((f) => `rules ${f.hardRules.join(',')}: ${f.entry.excerpt.slice(0, 100)}`)
      .join('\n')
    expect(report.cleanFalsePositives.length, detail).toBeLessThanOrEqual(
      GUARDRAIL_PASS_CRITERIA.clean_false_positive_max,
    )
  })

  it('does not fire an unrelated hard rule on a breaching excerpt', () => {
    const detail = report.overFiring
      .map((o) => `expected ${o.entry.expected_rule}, also fired ${o.extraRules.join(',')}`)
      .join('\n')
    expect(report.overFiring.length, detail).toBe(0)
  })

  it('reports the measured numbers per rule', () => {
    const rows = Object.keys(report.perRule)
      .map(Number)
      .sort((a, b) => a - b)
      .map((r) => `${r}:${report.perRule[r]?.caught}/${report.perRule[r]?.total}`)
    // Every rule but the retired rule 7 has breaching excerpts.
    expect(rows.length).toBe(HARD_RULE_MAX - 1)
    // Visible in the test output so a regression shows which rule moved.
    console.log(`[guardrails] output recall per rule -> ${rows.join(' ')}`)
  })
})
