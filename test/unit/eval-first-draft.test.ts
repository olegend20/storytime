import { describe, expect, it } from 'vitest'
import { firstDraftOf } from '@/lib/eval/live-pipeline'
import { summarize, type EvalScenarioRecord } from '@/lib/eval/harness'
import type { GenerationRequest, QualityResult, StoryOutput } from '@/lib/schemas'

/**
 * The owner's hill-climb metric (2026-10-08): "we continue to hill climb towards 0 rewrites
 * because our system is better up front". The eval reports how many first drafts went out
 * untouched, and why the others were sent back.
 */

const quality = (extra: Partial<QualityResult> = {}): QualityResult =>
  ({ outcome: 'pass', failures: [], hard_violations: [], rewrite_reasons: [], ...extra }) as unknown as QualityResult

describe('first draft', () => {
  it('passes only when it went out untouched', () => {
    expect(firstDraftOf(quality(), 1)).toEqual({ passed: true, failures: [], reasons: [], mended_rules: [], after_streaming: 'unchanged' })
  })

  it('a rewrite, a mend or a discard is a first draft that did not pass', () => {
    const rewritten = quality({
      attempt: 2,
      first_attempt: { failures: [{ check: 'fact_min_age', detail: 'PSI' }], reasons: ['explain PSI'] },
    } as Partial<QualityResult>)
    expect(firstDraftOf(rewritten, 2)).toEqual({
      passed: false,
      failures: ['fact_min_age'],
      reasons: ['explain PSI'],
      mended_rules: [],
      after_streaming: 'replaced',
    })
    const mended = quality({ mended: { edits: 1, cut: 0, rules: [10] } } as Partial<QualityResult>)
    expect(firstDraftOf(mended, 1)).toMatchObject({ passed: false, mended_rules: [10] })
    expect(firstDraftOf(quality({ outcome: 'discarded' } as Partial<QualityResult>), 1)?.passed).toBe(false)
  })

  it('VT-Q1 (#58): keeps the draft the gate reviewed first, and its request, for replaying the reviewer', () => {
    const story = { title: 'The Lost Signal', subtitle: null, chapters: [], true_facts: [] } as unknown as StoryOutput
    const request = { age_band: 'A', tones: ['calm'] } as unknown as GenerationRequest
    expect(firstDraftOf(quality(), 1, { story, request })).toMatchObject({ passed: true, story, request })
    expect(firstDraftOf(quality(), 1)).not.toHaveProperty('story')
  })

  it('VT-FR5 (#85): an in-place revision is a touched draft, edited after streaming, not replaced', () => {
    const revised = quality({ attempt: 1, first_attempt: { failures: [], reasons: ['facts contradict the fact pack'] }, mended: { edits: 4, cut: 0, rules: [] } } as Partial<QualityResult>)
    expect(firstDraftOf(revised, 1)).toMatchObject({ passed: false, after_streaming: 'edited' })
    // A rewrite that never arrived falls back to attempt 1 (#72): the page was not swapped.
    const fellBack = quality({ attempt: 2, outcome: 'flagged', rewrite_reasons: ['x', 'rewrite output unusable: rewrite_failed:dropped'] } as Partial<QualityResult>)
    expect(firstDraftOf(fellBack, 2)?.after_streaming).toBe('unchanged')
  })

  it('VT-FR5 (#85): the summary counts stories unchanged, edited and replaced after streaming', () => {
    const record = (after: 'unchanged' | 'edited' | 'replaced' | undefined): EvalScenarioRecord =>
      ({ scenario_id: 'x', overall_final: 4, caps_applied: [], word_count_in_range: true, disqualified: false, judge_ok: true, first_draft: { passed: after === 'unchanged', failures: [], reasons: [], mended_rules: [], ...(after ? { after_streaming: after } : {}) }, latency_to_first_chapter_ms: null, first_chapter_streamed: false, latency_total_ms: null, latency_by_step: {} }) as unknown as EvalScenarioRecord
    const summary = summarize([record('unchanged'), record('edited'), record('replaced'), record('replaced'), record(undefined)])
    expect(summary.after_streaming).toEqual({ unchanged: 1, edited: 1, replaced: 2, of: 4 })
    expect(summarize([record(undefined)]).after_streaming).toBeUndefined()
  })

  it('is unknown without a gate result', () => {
    expect(firstDraftOf(null, 1)).toBeNull()
  })

  it('the summary counts untouched first drafts over the stories that could tell', () => {
    const record = (first_draft: EvalScenarioRecord['first_draft']): EvalScenarioRecord =>
      ({ scenario_id: 'x', overall_final: 4, caps_applied: [], word_count_in_range: true, disqualified: false, judge_ok: true, first_draft, latency_to_first_chapter_ms: null, first_chapter_streamed: false, latency_total_ms: null, latency_by_step: {} }) as unknown as EvalScenarioRecord
    const summary = summarize([
      record({ passed: true, failures: [], reasons: [], mended_rules: [] }),
      record({ passed: false, failures: ['fact_min_age'], reasons: [], mended_rules: [] }),
      record(null),
    ])
    expect(summary.first_draft).toEqual({ passed: 1, of: 2 })
  })
})
