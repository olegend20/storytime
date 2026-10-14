import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { compareEvalRuns, mentions, sameScenarios, type EvalResult } from '@/lib/eval/harness'
import { previousResultPath, resultPaths } from '@/lib/eval/results'
import { syntheticStory } from '@/lib/eval/synthetic'
import { ChildAge, ChildFirstName, ChildLike, StoryBible, Tone } from '@/lib/schemas'
import {
  EVAL_SPLIT,
  evalScenarios,
  scenarioBand,
  scenarioSplit,
  selectScenarios,
} from '@/lib/eval/scenarios'

/**
 * Issue #48: the golden set grows from 8 to 32 with a fixed train/test split, so a
 * hill-climbing change can be kept only when both halves improve.
 */

const F13_EIGHT = [
  'lego-band-a-pair',
  'video-games-band-c-solo',
  'sharks-band-a-continuity',
  'soccer-band-c-continuity',
  'volcanoes-mixed-ages',
  'bees-band-a-5min',
  'space-race-band-c-15min',
  'titanic-band-b',
]

describe('issue #48: a 32-story golden set with a fixed train/test split', () => {
  it('VT-S1: 32 scenarios, F13\'s eight first and in order, every id unique', () => {
    const all = evalScenarios()
    expect(all).toHaveLength(32)
    expect(all.slice(0, 8).map((s) => s.id)).toEqual(F13_EIGHT)
    expect(new Set(all.map((s) => s.id)).size).toBe(32)
  })

  it('VT-S2: every band A-C x 5/10/15 cell has at least 3 stories, with one on each side of the split', () => {
    const all = evalScenarios()
    for (const band of ['A', 'B', 'C'] as const) {
      for (const minutes of [5, 10, 15] as const) {
        const cell = all.filter((s) => scenarioBand(s) === band && s.length_minutes === minutes)
        const label = `${band}${minutes}`
        expect(cell.length, label).toBeGreaterThanOrEqual(3)
        expect(cell.some((s) => scenarioSplit(s) === 'train'), `${label} train`).toBe(true)
        expect(cell.some((s) => scenarioSplit(s) === 'test'), `${label} test`).toBe(true)
      }
    }
    // Band D (13-17) is in the set too, which F13 never covered.
    expect(all.filter((s) => scenarioBand(s) === 'D').length).toBeGreaterThanOrEqual(3)
  })

  it('VT-S3: a fixed 16/16 split, with F13\'s eight four and four', () => {
    const all = evalScenarios()
    expect(Object.keys(EVAL_SPLIT).sort()).toEqual(all.map((s) => s.id).sort())
    expect(all.filter((s) => scenarioSplit(s) === 'train')).toHaveLength(16)
    expect(all.filter((s) => scenarioSplit(s) === 'test')).toHaveLength(16)
    const eight = all.filter((s) => F13_EIGHT.includes(s.id))
    expect(eight.filter((s) => scenarioSplit(s) === 'train')).toHaveLength(4)
  })

  it('VT-S4: split:train and split:test select their half; ids and all still work', () => {
    const all = evalScenarios()
    const train = selectScenarios(all, 'split:train')
    const test = selectScenarios(all, 'split:test')
    expect(train).toHaveLength(16)
    expect(test).toHaveLength(16)
    expect(train.every((s) => EVAL_SPLIT[s.id] === 'train')).toBe(true)
    expect(new Set([...train, ...test].map((s) => s.id)).size).toBe(32)
    expect(selectScenarios(all, 'all')).toHaveLength(32)
    expect(selectScenarios(all, 'bees-band-a-5min,titanic-band-b').map((s) => s.id)).toEqual([
      'bees-band-a-5min',
      'titanic-band-b',
    ])
    expect(() => selectScenarios(all, 'split:validation')).toThrow(/Unknown scenario/)
  })

  it('VT-S5: every scenario is a real family a parent could create - the five child fields only, valid bibles', () => {
    for (const s of evalScenarios()) {
      expect(s.tones.length, s.id).toBeGreaterThanOrEqual(1)
      expect(s.tones.length, s.id).toBeLessThanOrEqual(2)
      for (const t of s.tones) expect(Tone.safeParse(t).success, `${s.id} tone ${t}`).toBe(true)
      for (const c of s.children) {
        // Rule 7: name, age, likes, notes (reading level is optional and unused here). Nothing else.
        expect(Object.keys(c).sort(), s.id).toEqual(['age', 'likes', 'name', 'notes'])
        expect(ChildFirstName.safeParse(c.name).success, `${s.id} ${c.name}`).toBe(true)
        expect(ChildAge.safeParse(c.age).success, `${s.id} ${c.name} age`).toBe(true)
        expect(c.likes.length, s.id).toBeLessThanOrEqual(10)
        for (const like of c.likes) expect(ChildLike.safeParse(like).success, `${s.id} like ${like}`).toBe(true)
        expect((c.notes ?? '').length, s.id).toBeLessThanOrEqual(300)
      }
      if (s.bible) expect(StoryBible.safeParse(s.bible).success, `${s.id} bible`).toBe(true)
    }
  })
})

describe('issue #48 review: continuity matching, run ordering and like-with-like comparison', () => {
  it('VT-S6: a continuity string matches whole words, and a short name only as a name', () => {
    expect(mentions('The T. rex had a terrible bite.', 'Bit')).toBe(false)
    expect(mentions('Just a bit further, said the rabbit.', 'Bit')).toBe(false)
    expect(mentions('Bit beeped twice. BZZZT!', 'Bit')).toBe(true)
    expect(mentions('What a coincidence!', 'coin')).toBe(false)
    expect(mentions('One golden coin glowed.', 'coin')).toBe(true)
    // Longer needles stay case-insensitive, as they always were.
    expect(mentions('"Play well," said Juno.', 'Play well')).toBe(true)
    expect(mentions('The red Lego brick clicked.', 'red LEGO brick')).toBe(true)
    // Plurals still count, as they did under the substring match.
    expect(mentions('His golden coins jingled.', 'coin')).toBe(true)
    expect(mentions('Two red bricks clicked together.', 'red brick')).toBe(true)
    expect(mentions('The rabbits hopped away.', 'Bit')).toBe(false)
  })

  it('VT-S7: a series story in the synthetic pipeline opens on its own recurring element', () => {
    const maya = evalScenarios().find((s) => s.id === 'space-race-band-b-15min-continuity')!
    const story = syntheticStory({ scenario: maya, writingModel: 'claude-sonnet-5', sample: 1 })
    expect(story.chapters[0]!.text).toContain('Barnacle')
  })

  it('VT-S8: same-day result files order by their suffix, so the newest run is last', () => {
    const dir = mkdtempSync(join(tmpdir(), 'storytime-results-order-'))
    for (const f of ['eval-2026-10-14.json', 'eval-2026-10-14-3.json', 'eval-2026-10-13.json', 'eval-2026-10-14-2.json']) {
      writeFileSync(join(dir, f), '{}')
    }
    expect(resultPaths('eval-', { dir }).map((p) => basename(p))).toEqual([
      'eval-2026-10-13.json',
      'eval-2026-10-14.json',
      'eval-2026-10-14-2.json',
      'eval-2026-10-14-3.json',
    ])
    expect(basename(previousResultPath('eval-', { dir })!)).toBe('eval-2026-10-14-3.json')
  })

  it('VT-S9: runs over different stories are recognised, and their comparison says so', () => {
    const run = (ids: string[]) =>
      ({
        date: '2026-10-14',
        judge_prompt: { version: 'judge.v2', sha256: 'x' },
        pipeline: 'live',
        scenarios: ids.map((id) => ({ scenario_id: id, overall_final: 4 })),
        summary: { mean_overall: 4, min_overall: 4, disqualified: 0 },
      }) as unknown as EvalResult
    const train = run(selectScenarios(evalScenarios(), 'split:train').map((s) => s.id))
    const test = run(selectScenarios(evalScenarios(), 'split:test').map((s) => s.id))
    expect(sameScenarios(train, train)).toBe(true)
    expect(sameScenarios(train, test)).toBe(false)
    expect(compareEvalRuns(test, train)).toMatch(/different stories \(16 now, 16 then\)/)
    expect(compareEvalRuns(train, train)).not.toMatch(/different stories/)
  })
})
