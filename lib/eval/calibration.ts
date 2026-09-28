import { EVAL_PASS_CRITERIA, wordCountWithinTolerance, type JudgeScore } from '@/lib/schemas'
import type { GenerationLogSink } from '@/lib/ai'
import { loadJudgePrompt, pairwiseWithSwap, scoreStory, type JudgeCallCommon } from './judge'
import { REFERENCE_FILES, loadReferenceCases, referenceCase, type ReferenceCase } from './references'
import {
  injectGreatWhiteChase,
  injectInventedDates,
  padWithRepeatedDescription,
  removeChildFromAllButOneChapter,
} from './sabotage'
import type { CapContext } from './types'

/**
 * Judge calibration - JUDGE_AGENT.md §5.
 *
 * "Run before every bake-off and whenever prompts/judge.*.md changes." F13's first AC is
 * that calibration passes *before results count*, so `pnpm eval` and `pnpm bakeoff` both
 * run this first and refuse to report anything if it fails.
 *
 * Two rules govern how the expectations are checked, and both matter:
 *
 *  1. **The sabotage expectations are checked against the judge's RAW criterion scores**,
 *     before our automatic caps are applied. Our caps could satisfy three of the four
 *     sabotage rows by arithmetic alone (a padded story is long, an unsourced fact is
 *     unsourced), and a calibration row that passes because of our own code measures our
 *     code, not the judge. The capped scores are recorded alongside, never checked.
 *  2. **If an expectation fails, fix the judge prompt - never the references.** §5 says so
 *     explicitly, and `notes` repeats it in every result file so nobody is tempted.
 */

export interface CalibrationExpectation {
  id: string
  description: string
  passed: boolean
  detail: string
  observed: Record<string, unknown>
}

export interface CalibrationReferenceScore {
  file: string
  band: string
  word_count: number
  scores_raw: JudgeScore['scores'] | null
  overall_raw: number | null
  /** Median of `overall_samples`. Null when every run errored. */
  overall_final: number | null
  /** Every repeat's overall, so a reader can see the spread rather than trust one draw. */
  overall_samples: number[]
  overall_spread: number | null
  caps_applied: string[]
  disqualified: boolean
  cap_context: CapContext | null
  judge_error: string | null
}

export interface CalibrationResult {
  ran_at: string
  judge_model: string
  judge_prompt: { version: string; sha256: string }
  passed: boolean
  expectations: CalibrationExpectation[]
  reference_scores: CalibrationReferenceScore[]
  judge_calls: number
  cost_usd: number
  notes: string[]
}

function expectation(
  id: string,
  description: string,
  passed: boolean,
  detail: string,
  observed: Record<string, unknown> = {},
): CalibrationExpectation {
  return { id, description, passed, detail, observed }
}

export interface RunCalibrationOptions extends JudgeCallCommon {
  sink?: GenerationLogSink
}

export async function runCalibration(
  opts: RunCalibrationOptions = {},
): Promise<CalibrationResult> {
  const prompt = loadJudgePrompt(opts.promptFile ?? undefined)
  const cases = loadReferenceCases()
  if (cases.length < 4) {
    throw new Error(
      `Calibration needs all four reference stories; the manifest lists ${cases.length}.`,
    )
  }

  const expectations: CalibrationExpectation[] = []
  const referenceScores: CalibrationReferenceScore[] = []
  let calls = 0
  let cost = 0
  let judgeModel = ''

  const scoreCase = async (
    c: ReferenceCase,
    story = c.story,
  ): Promise<Awaited<ReturnType<typeof scoreStory>>> => {
    const res = await scoreStory({ ...opts, context: c.context, story, gate: null, factPack: null })
    calls += 1
    cost += res.costUsd
    if (res.model) judgeModel = res.model
    return res
  }

  /**
   * ---- Row 1: the four references, each with its real request.
   *
   * Scored CALIBRATION_REPEATS times and reduced to a median, because §2 says "report medians
   * and spreads, not single samples" and the judge's measured overall spread is 0.35 - a
   * single-sample threshold flapped (the LEGO story scored 4.65 then 4.45 on identical runs).
   * A floor catches a broken judge; the mean catches drift. Owner's decision 2026-09-28.
   */
  const repeats = EVAL_PASS_CRITERIA.calibration_repeats
  const floor = EVAL_PASS_CRITERIA.calibration_reference_floor
  const scored = new Map<string, Awaited<ReturnType<typeof scoreStory>>>()

  const median = (xs: number[]): number => {
    const a = [...xs].sort((x, y) => x - y)
    const m = Math.floor(a.length / 2)
    return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2
  }

  for (const c of cases) {
    const runs: Awaited<ReturnType<typeof scoreStory>>[] = []
    for (let i = 0; i < repeats; i += 1) runs.push(await scoreCase(c))
    const ok = runs.filter((r) => r.ok)
    // The median run is what the other calibration rows compare against.
    const overalls = ok.map((r) => (r.ok ? r.final.overall : 0))
    const med = overalls.length > 0 ? median(overalls) : null
    const representative =
      ok.find((r) => r.ok && r.final.overall === med) ?? runs.find((r) => r.ok) ?? runs[0]!
    scored.set(c.entry.file, representative)
    referenceScores.push({
      file: c.entry.file,
      band: c.entry.request.age_band,
      word_count: c.wordCount,
      scores_raw: representative.ok ? representative.raw.scores : null,
      overall_raw: representative.ok ? representative.raw.overall : null,
      overall_final: med,
      overall_samples: overalls,
      overall_spread: overalls.length > 0 ? Math.max(...overalls) - Math.min(...overalls) : null,
      caps_applied: representative.ok ? representative.final.caps_applied : [],
      disqualified: representative.ok ? representative.final.disqualified : false,
      cap_context: representative.ok ? representative.capContext : null,
      judge_error: representative.ok ? null : representative.reason,
    })
  }

  const belowFloor = referenceScores.filter(
    (r) => r.overall_final === null || r.overall_final < floor,
  )
  const medians = referenceScores.map((r) => r.overall_final ?? 0)
  const refMean = medians.reduce((a, b) => a + b, 0) / Math.max(1, medians.length)
  const drift = Math.abs(refMean - EVAL_PASS_CRITERIA.calibration_baseline_mean)
  const drifted = drift > EVAL_PASS_CRITERIA.calibration_mean_tolerance
  const detail = referenceScores
    .map((r) => `${r.file}=${r.overall_final ?? r.judge_error}[${(r.overall_samples ?? []).join('/')}]`)
    .join(', ')

  expectations.push(
    expectation(
      'references_above_floor',
      `Each of the four references medians >= ${floor} over ${repeats} runs (the mean is reported, not gated)`,
      belowFloor.length === 0,
      belowFloor.length === 0
        ? `mean of medians ${refMean.toFixed(3)} vs ${EVAL_PASS_CRITERIA.calibration_baseline_mean} baseline (drift ${drift.toFixed(3)}); ${detail}` +
            (drifted
              ? ` — WARNING: the mean moved ${drift.toFixed(2)}, beyond the ${EVAL_PASS_CRITERIA.calibration_mean_tolerance} measured spread. A human should look before trusting this run.`
              : '')
        : `below the ${floor} floor: ${belowFloor.map((r) => `${r.file}=${r.overall_final ?? r.judge_error}`).join('; ')}. §5: fix the judge prompt, never the references.`,
      {
        per_story: referenceScores.map((r) => ({
          file: r.file,
          median: r.overall_final,
          samples: r.overall_samples,
          spread: r.overall_spread,
        })),
        mean_of_medians: Number(refMean.toFixed(3)),
        baseline_mean: EVAL_PASS_CRITERIA.calibration_baseline_mean,
        drift_from_baseline: Number(drift.toFixed(3)),
        mean_is_gated: false,
        drift_warning: drifted,
      },
    ),
  )

  // ---- Row 2: center. Phoenix removed from all but one chapter of the LEGO story.
  const lego = referenceCase(cases, REFERENCE_FILES.lego)
  const heroSab = removeChildFromAllButOneChapter(lego.story, {
    remove: 'Phoenix',
    keepWith: 'Cruz',
    keepChapter: 0,
  })
  const heroRes = await scoreCase(lego, heroSab.story)
  expectations.push(
    expectation(
      'sabotage_heroes',
      "LEGO story with Phoenix's name removed from all but one chapter scores center <= 2",
      heroRes.ok && heroRes.raw.scores.center <= 2,
      heroRes.ok
        ? `center=${heroRes.raw.scores.center} (raw), kept in "${heroSab.keptChapterHeading}", ${heroSab.strippedFrom} mentions removed. Evidence: ${heroRes.raw.evidence.center}`
        : `judge_error: ${heroRes.reason}`,
      heroRes.ok ? { scores_raw: heroRes.raw.scores, kept_chapter: heroSab.keptChapter } : {},
    ),
  )

  // ---- Row 3: facts. Three invented dates in the soccer story, named in the evidence.
  const soccer = referenceCase(cases, REFERENCE_FILES.soccer)
  const factSab = injectInventedDates(soccer.story)
  const factRes = await scoreCase(soccer, factSab.story)
  const namedDates = factRes.ok
    ? factSab.injectedDates.filter((d) =>
        `${factRes.raw.evidence.facts} ${factRes.raw.caps_applied.join(' ')} ${factRes.raw.editor_notes.join(' ')}`.includes(
          d,
        ),
      )
    : []
  expectations.push(
    expectation(
      'sabotage_facts',
      'Soccer story with three invented dates scores facts <= 2 and the evidence names at least two of them',
      factRes.ok && factRes.raw.scores.facts <= 2 && namedDates.length >= 2,
      factRes.ok
        ? `facts=${factRes.raw.scores.facts} (raw); named ${namedDates.length}/3 injected dates (${namedDates.join(', ') || 'none'}). Evidence: ${factRes.raw.evidence.facts}`
        : `judge_error: ${factRes.reason}`,
      factRes.ok
        ? {
            scores_raw: factRes.raw.scores,
            injected: factSab.details,
            named_dates: namedDates,
            fact_sourcing: factRes.capContext.factSourcing,
          }
        : {},
    ),
  )

  // ---- Row 4: age fit. A band A chase-and-ram sequence.
  const sharks = referenceCase(cases, REFERENCE_FILES.sharks)
  const greatWhiteIndex = sharks.story.chapters.findIndex((c) => /great white/i.test(c.heading))
  const perilSab = injectGreatWhiteChase(
    sharks.story,
    greatWhiteIndex === -1 ? sharks.story.chapters.length - 2 : greatWhiteIndex,
  )
  const perilRes = await scoreCase(sharks, perilSab.story)
  expectations.push(
    expectation(
      'sabotage_age_fit_peril',
      'Shark story where the great white chases and rams the submarine scores age_fit <= 2 for band A',
      perilRes.ok && perilRes.raw.scores.age_fit <= 2,
      perilRes.ok
        ? `age_fit=${perilRes.raw.scores.age_fit} (raw); word count ${perilSab.wordCountBefore} -> ${perilSab.wordCountAfter}${perilSab.lengthUnchangedEnough ? ', length effectively unchanged so this is peril and not padding' : ', WARNING: length moved enough that the word-count cap may be doing the work'}. Evidence: ${perilRes.raw.evidence.age_fit}`
        : `judge_error: ${perilRes.reason}`,
      perilRes.ok
        ? {
            scores_raw: perilRes.raw.scores,
            disqualified_by_judge: perilRes.raw.disqualified,
            word_count_before: perilSab.wordCountBefore,
            word_count_after: perilSab.wordCountAfter,
          }
        : {},
    ),
  )

  // ---- Row 5: padding. 900 extra words in the video-game story.
  const videoGames = referenceCase(cases, REFERENCE_FILES.videoGames)
  const padSab = padWithRepeatedDescription(videoGames.story, 900)
  padSab.stillWithinLengthTolerance = wordCountWithinTolerance(
    padSab.wordCountAfter,
    videoGames.context.target_words,
  )
  const padRes = await scoreCase(videoGames, padSab.story)
  const original = scored.get(REFERENCE_FILES.videoGames)
  /**
   * Padding is penalised on DELIGHT, not age fit (§5, owner's decision 2026-09-28).
   *
   * §3 already gives age fit a mechanical claim on length - outside target ±15% caps it at 3 -
   * and this sabotage deliberately lands INSIDE the tolerance, so docking age fit as well
   * would duplicate that rule and blur the criterion. Delight's own anchor ends "No filler
   * sentences", and 900 words of repeated description is filler. A 10-year-old story padded
   * to 3,390 words is still pitched at a 10-year-old; it is just worse to read aloud.
   *
   * The drop must be REAL: the previous expectation was "no higher than the original", which
   * a tie would satisfy, so it tested almost nothing.
   */
  const PADDING_MIN_DELIGHT_DROP = 2
  const originalDelight = original?.ok === true ? original.raw.scores.delight : null
  const delightDrop =
    padRes.ok && originalDelight !== null ? originalDelight - padRes.raw.scores.delight : null
  const delightOk = delightDrop !== null && delightDrop >= PADDING_MIN_DELIGHT_DROP
  expectations.push(
    expectation(
      'sabotage_padding',
      'Video-game story padded with 900 words of repeated description drops delight by >= 2 versus the original',
      padRes.ok && delightOk,
      padRes.ok
        ? `delight=${padRes.raw.scores.delight} vs original ${originalDelight ?? 'n/a'} (drop ${delightDrop ?? 'n/a'}, need >= ${PADDING_MIN_DELIGHT_DROP}); age_fit=${padRes.raw.scores.age_fit} recorded but not asserted; ${padSab.wordCountBefore} -> ${padSab.wordCountAfter} words, ${padSab.stillWithinLengthTolerance ? 'STILL inside the ±15% tolerance, so the word-count cap does not fire and this row rests entirely on the judge noticing the padding' : 'outside the tolerance, so the cap would also fire'}`
        : `judge_error: ${padRes.reason}`,
      padRes.ok
        ? {
            scores_raw: padRes.raw.scores,
            original_delight: originalDelight,
            words_added: padSab.wordsAdded,
            still_within_tolerance: padSab.stillWithinLengthTolerance,
          }
        : {},
    ),
  )

  // ---- Row 6: pairwise. Original LEGO vs the sabotaged copy, both orders.
  const pair = await pairwiseWithSwap({
    context: lego.context,
    challenger: lego.story,
    baseline: heroSab.story,
    common: opts,
  })
  calls += 2
  cost += pair.costUsd
  if (pair.model) judgeModel = pair.model
  const firstConf = pair.firstOrder?.confidence ?? 0
  const secondConf = pair.secondOrder?.confidence ?? 0
  const bothOrdersOriginal = pair.verdict === 'A' && !pair.flipped
  expectations.push(
    expectation(
      'pairwise_original_beats_sabotage',
      'Pairwise: the original LEGO story beats the sabotaged copy in both orders with confidence >= 0.7',
      bothOrdersOriginal && firstConf >= 0.7 && secondConf >= 0.7,
      bothOrdersOriginal
        ? `original won both orders; confidences ${firstConf} and ${secondConf}`
        : `verdict=${pair.verdict}${pair.flipped ? ' (orders disagreed, recorded as TIE)' : ''}; confidences ${firstConf} and ${secondConf}${pair.errors.length > 0 ? `; errors: ${pair.errors.join(' | ')}` : ''}`,
      {
        verdict: pair.verdict,
        flipped: pair.flipped,
        first_order_verdict: pair.firstOrder?.verdict ?? null,
        swapped_order_verdict: pair.secondOrder?.verdict ?? null,
        swapped_as_first_terms: pair.secondOrderAsFirstTerms,
        confidences: [firstConf, secondConf],
      },
    ),
  )

  const notes = [
    '§5: if an expectation fails, fix the judge prompt - never the reference stories.',
    'The five sabotage/pairwise rows are checked against the judge\'s RAW criterion scores, before our automatic caps, so no row can pass because of our own arithmetic.',
    'The reference stories predate fact packs, so `unsourced_fact` is recorded as unverifiable rather than passed (see lib/eval/caps.ts).',
    'Manifest note: references 1 and 3 use British spelling, 2 and 4 American. The app defaults to American; prompts/judge.v2.md instructs the judge not to deduct for either.',
    `Two of the four references carry 11 headed sections and do not validate against StoryOutput (DECISIONS.md #25), so calibration scores the looser JudgeableStory shape.`,
  ]

  return {
    ran_at: new Date().toISOString(),
    judge_model: judgeModel,
    judge_prompt: { version: prompt.version, sha256: prompt.sha256 },
    passed: expectations.every((e) => e.passed),
    expectations,
    reference_scores: referenceScores,
    judge_calls: calls,
    cost_usd: Math.round(cost * 1e6) / 1e6,
    notes,
  }
}

/** One line per expectation, for the console. */
export function formatCalibration(result: CalibrationResult): string {
  const lines = [
    `Judge calibration (JUDGE_AGENT.md §5) - ${result.passed ? 'PASS' : 'FAIL'}`,
    `  judge: ${result.judge_model || '(unknown)'}  prompt: ${result.judge_prompt.version}@${result.judge_prompt.sha256}`,
    `  ${result.judge_calls} judge calls, $${result.cost_usd.toFixed(4)}`,
  ]
  for (const e of result.expectations) {
    lines.push(`  [${e.passed ? 'PASS' : 'FAIL'}] ${e.id}: ${e.detail}`)
  }
  if (!result.passed) {
    lines.push('  Results do not count until calibration passes (F13 AC).')
  }
  return lines.join('\n')
}
