import { describe, expect, it } from 'vitest'
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
