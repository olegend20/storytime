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

  it('VT-FR5 (#85): read from the stories - the same title and headings with new text is edited, a new title is replaced', () => {
    const request = { age_band: 'A' } as unknown as GenerationRequest
    const first = { title: 'The Lost Signal', subtitle: null, chapters: [{ heading: 'One', text: 'Milo watched.' }], ending_line: 'Goodnight.', true_facts: [] } as unknown as StoryOutput
    const edited = { ...first, chapters: [{ heading: 'One', text: 'Milo pulled the rope.' }] } as StoryOutput
    const rewritten = { ...first, title: 'A New Story' } as StoryOutput
    const sentBack = quality({ attempt: 1, first_attempt: { failures: [], reasons: ['facts contradict the fact pack'] } } as Partial<QualityResult>)
    expect(firstDraftOf(sentBack, 1, { story: first, request }, edited)).toMatchObject({ passed: false, after_streaming: 'edited' })
    expect(firstDraftOf(quality(), 1, { story: first, request }, first)).toMatchObject({ passed: true, after_streaming: 'unchanged' })
    expect(firstDraftOf(quality({ attempt: 2 } as Partial<QualityResult>), 2, { story: first, request }, rewritten)?.after_streaming).toBe('replaced')
    // A rewrite that never arrived falls back to attempt 1 (#72), even if the ladder then mends it: not swapped.
    const fellBack = quality({ attempt: 2, outcome: 'flagged', rewrite_reasons: ['x'], mended: { edits: 1, cut: 0, rules: [10] } } as Partial<QualityResult>)
    expect(firstDraftOf(fellBack, 2, { story: first, request }, edited)?.after_streaming).toBe('edited')
    // Rung 3's shorter retry replaced the unusable draft that streamed.
    const shorter = quality({ attempt: 2, first_attempt: { failures: [], reasons: ['output unusable; retried 15 -> 10 minutes'] } } as Partial<QualityResult>)
    expect(firstDraftOf(shorter, 2, { story: first, request }, first)?.after_streaming).toBe('replaced')
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
