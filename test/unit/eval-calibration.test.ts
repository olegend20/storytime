import { describe, expect, it } from 'vitest'
import { countWords, wordCountWithinTolerance } from '@/lib/schemas'
import { runCalibration } from '@/lib/eval/calibration'
import { narrativeWordCount } from '@/lib/eval/render'
import { REFERENCE_FILES, loadReferenceCases, referenceCase, toJudgeable } from '@/lib/eval/references'
import {
  SabotageError,
  injectGreatWhiteChase,
  injectInventedDates,
  padWithRepeatedDescription,
  removeChildFromAllButOneChapter,
} from '@/lib/eval/sabotage'
import { loadReferenceStory } from '@/lib/reference'
import { pairwiseResponse, scoreResponse, withScriptedJudge } from '../helpers/judge-fixtures'
import type { JudgeScoreWithExcerpts } from '@/lib/eval/judge'

/**
 * JUDGE_AGENT.md §5 - the calibration set, and the four sabotaged variants it needs.
 *
 * Two things are tested separately and must not be confused:
 *   1. **The sabotages do what they claim.** Deterministic, no model involved. A sabotage
 *      that silently no-ops would make calibration pass for the wrong reason, so each one
 *      asserts its own effect and this file asserts it again.
 *   2. **The calibration checker reaches the right verdict** given a judge that behaves as
 *      §5 expects, and the wrong verdict is reported rather than swallowed given a judge
 *      that flatters. This tests OUR checker. Whether the real judge behaves is the
 *      LIVE_API row in §7 and is not, and cannot be, settled here.
 */

const cases = loadReferenceCases()
const ALL_FIVES = { heroes: 5, craft: 5, facts: 5, age_fit: 5, continuity: 5, delight: 5 }

describe('§5 sabotage: a child removed from all but one chapter', () => {
  const lego = referenceCase(cases, REFERENCE_FILES.lego)

  it('leaves the name in exactly one chapter and rewrites the rest as a solo', () => {
    const before = lego.story.chapters.filter((c) => /\bPhoenix\b/.test(c.text)).length
    expect(before).toBeGreaterThan(5)

    const sab = removeChildFromAllButOneChapter(lego.story, {
      remove: 'Phoenix',
      keepWith: 'Cruz',
      keepChapter: 0,
    })
    const after = sab.story.chapters.filter((c) => /\bPhoenix\b/.test(c.text))
    expect(after.length).toBe(1)
    expect(sab.keptChapter).toBe(0)
    expect(sab.strippedFrom).toBeGreaterThan(5)
    // The other child now carries the chapters alone - no sentence left with two subjects.
    expect(sab.story.chapters[9]!.text).not.toMatch(/Cruz and Cruz/)
  })

  it('keeps the story the same length, so nothing but heroes has changed', () => {
    const sab = removeChildFromAllButOneChapter(lego.story, {
      remove: 'Phoenix',
      keepWith: 'Cruz',
      keepChapter: 0,
    })
    const delta = Math.abs(narrativeWordCount(sab.story) - narrativeWordCount(lego.story))
    expect(delta).toBeLessThan(30)
  })

  it('is deterministic', () => {
    const opts = { remove: 'Phoenix', keepWith: 'Cruz', keepChapter: 0 }
    const a = removeChildFromAllButOneChapter(lego.story, opts)
    const b = removeChildFromAllButOneChapter(lego.story, opts)
    expect(JSON.stringify(a.story)).toBe(JSON.stringify(b.story))
  })

  it('throws rather than silently no-op when the name is not there', () => {
    expect(() =>
      removeChildFromAllButOneChapter(lego.story, { remove: 'Zephyrine', keepWith: 'Cruz' }),
    ).toThrow(SabotageError)
  })
})

describe('§5 sabotage: three invented dates', () => {
  const soccer = referenceCase(cases, REFERENCE_FILES.soccer)

  it('replaces the three years in the prose, the headings and the True Facts list', () => {
    const sab = injectInventedDates(soccer.story)
    const all = JSON.stringify(sab.story)
    for (const wrong of ['1847', '1911', '1926']) expect(all).toContain(wrong)
    // The real years are gone from the passages that stated them.
    expect(sab.story.chapters.some((c) => c.text.includes("It's **1847**"))).toBe(true)
    expect(sab.story.chapters.some((c) => c.heading.includes('(London, 1847)'))).toBe(true)
    expect(sab.story.true_facts.some((f) => f.text.includes('formed in 1847'))).toBe(true)
    expect(sab.injectedDates).toEqual(['1847', '1911', '1926'])
    expect(sab.details).toHaveLength(3)
  })

  it('throws if an anchor is missing, rather than injecting two dates and calling it three', () => {
    const mangled = {
      ...soccer.story,
      chapters: soccer.story.chapters.map((c) => ({ ...c, text: c.text.split('**1863**').join('1863') })),
    }
    expect(() => injectInventedDates(mangled)).toThrow(SabotageError)
  })

  it('changes nothing but the dates', () => {
    const sab = injectInventedDates(soccer.story)
    expect(narrativeWordCount(sab.story)).toBe(narrativeWordCount(soccer.story))
  })
})

describe('§5 sabotage: the great white chases and rams the submarine', () => {
  const sharks = referenceCase(cases, REFERENCE_FILES.sharks)
  const index = sharks.story.chapters.findIndex((c) => /great white/i.test(c.heading))

  it('replaces the great-white chapter with band-A-illegal peril', () => {
    const sab = injectGreatWhiteChase(sharks.story, index)
    const text = sab.story.chapters[index]!.text
    expect(text).toMatch(/chased them through the dark/)
    expect(text).toMatch(/rammed them again/)
    expect(text).toMatch(/right behind us/)
    expect(sab.replacedHeading).toMatch(/Great White/i)
  })

  it('keeps the word count inside the band, so age_fit cannot be capped by length instead', () => {
    const sab = injectGreatWhiteChase(sharks.story, index)
    expect(sab.lengthUnchangedEnough).toBe(true)
    expect(wordCountWithinTolerance(sab.wordCountAfter, sharks.context.target_words)).toBe(true)
  })

  it('refuses to sabotage the wrong chapter', () => {
    expect(() => injectGreatWhiteChase(sharks.story, 0)).toThrow(SabotageError)
    expect(() => injectGreatWhiteChase(sharks.story, 99)).toThrow(SabotageError)
  })
})

describe('§5 sabotage: 900 words of padding', () => {
  const videoGames = referenceCase(cases, REFERENCE_FILES.videoGames)

  it('adds about 900 words of visibly repeated description to the body chapters', () => {
    const sab = padWithRepeatedDescription(videoGames.story, 900)
    expect(sab.wordsAdded).toBeGreaterThanOrEqual(900)
    expect(sab.wordsAdded).toBeLessThan(960)
    // Cold open and coda untouched: the opening and the landing still read as written.
    expect(sab.story.chapters[0]!.text).toBe(videoGames.story.chapters[0]!.text)
    const last = sab.story.chapters.length - 1
    expect(sab.story.chapters[last]!.text).toBe(videoGames.story.chapters[last]!.text)
    expect(countWords(sab.story.chapters[1]!.text)).toBeGreaterThan(
      countWords(videoGames.story.chapters[1]!.text),
    )
  })

  it('stays INSIDE the band tolerance, which is what makes this row a real test', () => {
    // 2,474 + 900 = ~3,374 words, and band C at 10 minutes tolerates up to 3,680. So the
    // word-count cap does NOT fire, and `age_fit <= 3` has to come from the judge noticing
    // the padding. If this ever flips to false the row becomes a test of our arithmetic.
    const sab = padWithRepeatedDescription(videoGames.story, 900)
    expect(wordCountWithinTolerance(sab.wordCountAfter, videoGames.context.target_words)).toBe(true)
  })
})

describe('reference adaptation', () => {
  it('folds the cold open into chapter 1 so the judge scores the real opening', () => {
    const parsed = loadReferenceStory(REFERENCE_FILES.sharks)
    const story = toJudgeable(parsed)
    expect(story.chapters[0]!.text.startsWith(parsed.coldOpen.slice(0, 40))).toBe(true)
    // The cold open is folded in exactly once, upstream (DECISIONS.md #54). Folding again
    // here would double-count it: 2,102 words instead of 1,851 for the shark story.
    expect(narrativeWordCount(story)).toBe(parsed.narrativeWordCount)
  })

  /**
   * Both Lennon stories head their cold open, giving 11 markdown sections against the
   * 10-chapter cap. The upstream fold (DECISIONS.md #54) collapses that to 10, so no
   * reference now exceeds the cap - and every one stays inside its band word target.
   */
  it('brings every reference within the chapter cap and its band word target', () => {
    expect(cases.length).toBe(4)
    for (const c of cases) {
      expect(c.story.chapters.length, `${c.entry.file} chapters`).toBeLessThanOrEqual(10)
      expect(c.story.chapters.length, `${c.entry.file} chapters`).toBeGreaterThanOrEqual(6)
      expect(
        wordCountWithinTolerance(c.wordCount, c.context.target_words),
        `${c.entry.file}: ${c.wordCount} words vs ${c.context.target_words.min}-${c.context.target_words.max}`,
      ).toBe(true)
    }
  })

  it('scores every reference with its real request from the manifest', () => {
    for (const c of cases) {
      expect(c.context.topic_label).toBe(c.entry.request.topic_input)
      expect(c.context.age_band).toBe(c.entry.request.age_band)
      expect(c.context.children.map((x) => x.name)).toEqual(
        c.entry.request.children.map((x) => x.name),
      )
      // Continuity stories carry their prior bible; first stories carry none.
      expect(c.context.bible === null).toBe(c.entry.sequence === 1)
    }
  })
})

// ---------------------------------------------------------------------------
// The calibration checker itself
// ---------------------------------------------------------------------------

/**
 * A judge that behaves exactly as §5 expects. The responder is called once per NEW payload,
 * in call order: four references, then the four sabotages, then the two pairwise orders.
 */
function scriptedJudge(opts: {
  sabotageScores?: Partial<Record<'heroes' | 'facts' | 'peril' | 'padding', JudgeScoreWithExcerpts['scores']>>
  factEvidence?: string
  pairwise?: ('A' | 'B' | 'TIE')[]
  pairwiseConfidence?: number
}): (info: { purpose: string }) => string {
  let scoreCall = 0
  let pairwiseCall = 0
  const s = opts.sabotageScores ?? {}
  return ({ purpose }) => {
    if (purpose === 'judge_pairwise') {
      const verdicts = opts.pairwise ?? ['A', 'B']
      const verdict = verdicts[pairwiseCall] ?? 'TIE'
      pairwiseCall += 1
      return pairwiseResponse(verdict, opts.pairwiseConfidence ?? 0.85)
    }
    scoreCall += 1
    if (scoreCall <= 4) return scoreResponse(ALL_FIVES)
    if (scoreCall === 5) {
      return scoreResponse(s.heroes ?? { ...ALL_FIVES, heroes: 2 }, {
        evidence: {
          heroes: 'Phoenix is named in the goodnight line and in one chapter, and does nothing anywhere else.',
          craft: 'ok',
          facts: 'ok',
          age_fit: 'ok',
          continuity: 'ok',
          delight: 'ok',
        },
      })
    }
    if (scoreCall === 6) {
      return scoreResponse(s.facts ?? { ...ALL_FIVES, facts: 2 }, {
        evidence: {
          heroes: 'ok',
          craft: 'ok',
          facts:
            opts.factEvidence ??
            'The Football Association is dated 1847 (it was 1863) and the penalty kick 1911 (it was 1891).',
          age_fit: 'ok',
          continuity: 'ok',
          delight: 'ok',
        },
      })
    }
    if (scoreCall === 7) {
      return scoreResponse(s.peril ?? { ...ALL_FIVES, age_fit: 2 }, {
        evidence: {
          heroes: 'ok',
          craft: 'ok',
          facts: 'ok',
          age_fit: 'A great white rams the submarine and chases them into the dark. Band A allows no chasing at all.',
          continuity: 'ok',
          delight: 'ok',
        },
      })
    }
    return scoreResponse(s.padding ?? { ...ALL_FIVES, age_fit: 3, delight: 3 })
  }
}

describe('§5 calibration checker', () => {
  it('passes when the judge behaves as §5 expects', async () => {
    const result = await withScriptedJudge(() => runCalibration(), scriptedJudge({}))
    expect(
      result.expectations.filter((e) => !e.passed).map((e) => `${e.id}: ${e.detail}`),
    ).toEqual([])
    expect(result.passed).toBe(true)
    expect(result.judge_calls).toBe(10)
    expect(result.expectations.map((e) => e.id)).toEqual([
      'references_score_at_least_4_5',
      'sabotage_heroes',
      'sabotage_facts',
      'sabotage_age_fit_peril',
      'sabotage_padding',
      'pairwise_original_beats_sabotage',
    ])
    expect(result.reference_scores).toHaveLength(4)
    for (const r of result.reference_scores) expect(r.overall_final).toBeGreaterThanOrEqual(4.5)
  })

  it('records that the fact-sourcing check could not be run on the references', async () => {
    const result = await withScriptedJudge(() => runCalibration(), scriptedJudge({ pairwiseConfidence: 0.9 }))
    for (const r of result.reference_scores) {
      expect(r.cap_context?.factSourcing).toBe('unverifiable_no_fact_pack')
    }
    expect(result.notes.join(' ')).toMatch(/unsourced_fact/)
    expect(result.notes.join(' ')).toMatch(/British spelling/)
    expect(result.notes.join(' ')).toMatch(/fix the judge prompt - never the reference/)
  })

  it('fails - loudly and per row - when the judge flatters every sabotage', async () => {
    const result = await withScriptedJudge(
      () => runCalibration(),
      scriptedJudge({
        sabotageScores: {
          heroes: ALL_FIVES,
          facts: ALL_FIVES,
          peril: ALL_FIVES,
          padding: ALL_FIVES,
        },
        factEvidence: 'The facts are all correct and beautifully woven in.',
        pairwise: ['TIE', 'TIE'],
      }),
    )
    expect(result.passed).toBe(false)
    const failed = result.expectations.filter((e) => !e.passed).map((e) => e.id)
    expect(failed).toEqual([
      'sabotage_heroes',
      'sabotage_facts',
      'sabotage_age_fit_peril',
      'sabotage_padding',
      'pairwise_original_beats_sabotage',
    ])
    // The references still score well: a flattering judge fails on discrimination, not on
    // the references, and the report has to say which.
    expect(result.expectations[0]!.passed).toBe(true)
  })

  it('fails the facts row when the judge drops the score but cannot name the dates', async () => {
    const result = await withScriptedJudge(
      () => runCalibration(),
      scriptedJudge({
        factEvidence: 'Some of the dates felt wrong to me.',
        pairwiseConfidence: 0.8,
      }),
    )
    const facts = result.expectations.find((e) => e.id === 'sabotage_facts')!
    expect(facts.passed).toBe(false)
    expect(facts.detail).toMatch(/named 0\/3/)
  })

  it('checks the sabotage rows against RAW scores, not against our caps', async () => {
    // The judge calls the peril sabotage a guardrail breach, which forces overall 1 through
    // applyCaps. The row must still fail, because it asks about age_fit and the judge said 5.
    const base = scriptedJudge({ pairwiseConfidence: 0.75 })
    const result = await withScriptedJudge(
      () => runCalibration(),
      (info) => {
        const text = base(info)
        if (info.purpose !== 'judge_score') return text
        const body = JSON.parse(text) as JudgeScoreWithExcerpts
        if (body.evidence.age_fit.includes('great white')) {
          return JSON.stringify({
            ...body,
            scores: { ...body.scores, age_fit: 5 },
            disqualified: true,
            caps_applied: ['guardrail_rule_3'],
          })
        }
        return text
      },
    )
    const peril = result.expectations.find((e) => e.id === 'sabotage_age_fit_peril')!
    expect(peril.passed).toBe(false)
    expect(peril.observed.disqualified_by_judge).toBe(true)
  })

  it('fails the pairwise row when the two orders disagree', async () => {
    const result = await withScriptedJudge(
      () => runCalibration(),
      // 'A' in the first order and 'A' in the swapped order means the judge preferred
      // whichever story came first: a position flip, which resolves to TIE.
      scriptedJudge({ pairwise: ['A', 'A'] }),
    )
    const pair = result.expectations.find((e) => e.id === 'pairwise_original_beats_sabotage')!
    expect(pair.passed).toBe(false)
    expect(pair.observed.flipped).toBe(true)
    expect(pair.observed.verdict).toBe('TIE')
  })

  it('fails the pairwise row when the winner is right but the judge is unsure', async () => {
    const result = await withScriptedJudge(
      () => runCalibration(),
      scriptedJudge({ pairwise: ['A', 'B'], pairwiseConfidence: 0.6 }),
    )
    const pair = result.expectations.find((e) => e.id === 'pairwise_original_beats_sabotage')!
    expect(pair.passed).toBe(false)
    expect(pair.detail).toMatch(/0\.6/)
  })
})
