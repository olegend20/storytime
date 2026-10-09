import { describe, expect, it } from 'vitest'
import { firstDraftOf } from '@/lib/eval/live-pipeline'
import { summarize, type EvalScenarioRecord } from '@/lib/eval/harness'
import type { QualityResult } from '@/lib/schemas'

/**
 * The owner's hill-climb metric (2026-10-08): "we continue to hill climb towards 0 rewrites
 * because our system is better up front". The eval reports how many first drafts went out
 * untouched, and why the others were sent back.
 */

const quality = (extra: Partial<QualityResult> = {}): QualityResult =>
  ({ outcome: 'pass', failures: [], hard_violations: [], rewrite_reasons: [], ...extra }) as unknown as QualityResult

describe('first draft', () => {
  it('passes only when it went out untouched', () => {
    expect(firstDraftOf(quality(), 1)).toEqual({ passed: true, failures: [], reasons: [], mended_rules: [] })
  })

  it('a rewrite, a mend or a discard is a first draft that did not pass', () => {
    const rewritten = quality({
      first_attempt: { failures: [{ check: 'fact_min_age', detail: 'PSI' }], reasons: ['explain PSI'] },
    } as Partial<QualityResult>)
    expect(firstDraftOf(rewritten, 2)).toEqual({
      passed: false,
      failures: ['fact_min_age'],
      reasons: ['explain PSI'],
      mended_rules: [],
    })
    const mended = quality({ mended: { edits: 1, cut: 0, rules: [10] } } as Partial<QualityResult>)
    expect(firstDraftOf(mended, 1)).toMatchObject({ passed: false, mended_rules: [10] })
    expect(firstDraftOf(quality({ outcome: 'discarded' } as Partial<QualityResult>), 1)?.passed).toBe(false)
  })

  it('is unknown without a gate result', () => {
    expect(firstDraftOf(null, 1)).toBeNull()
  })

  it('the summary counts untouched first drafts over the stories that could tell', () => {
    const record = (first_draft: EvalScenarioRecord['first_draft']): EvalScenarioRecord =>
      ({ scenario_id: 'x', overall_final: 4, caps_applied: [], word_count_in_range: true, disqualified: false, judge_ok: true, first_draft }) as unknown as EvalScenarioRecord
    const summary = summarize([
      record({ passed: true, failures: [], reasons: [], mended_rules: [] }),
      record({ passed: false, failures: ['fact_min_age'], reasons: [], mended_rules: [] }),
      record(null),
    ])
    expect(summary.first_draft).toEqual({ passed: 1, of: 2 })
  })
})
