import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryLogSink, modelForRole } from '@/lib/ai'
import { JUDGE_PURPOSES, runBakeoff, type BakeoffResult } from '@/lib/eval/bakeoff'
import { findIdentityLeaks } from '@/lib/eval/blind'
import { BAKEOFF_REPORT_SECTIONS, renderBakeoffReport } from '@/lib/eval/report'
import { nextResultPath, writeResultFile } from '@/lib/eval/results'
import { syntheticProvider } from '@/lib/eval/synthetic'
import { pairwiseResponse, scoreResponse, withScriptedJudge } from '../helpers/judge-fixtures'
import type { JudgeScoreWithExcerpts } from '@/lib/eval/judge'

/**
 * JUDGE_AGENT.md §7:
 *   - "int: bake-off harness runs on a 1-scenario × 2-contestant × 1-sample config in
 *      fixture mode and produces the markdown report with all sections present."
 *   - "int: the report's cost figures reconcile with generation_logs for the run (sum
 *      matches within 0.1%)."
 *
 * The stories come from the synthetic pipeline (no F6 yet) and the judge replays fabricated
 * fixtures through the real `callModel()` path. What is under test is the harness: the
 * protocol order, the position swap, the second judge, the reconciliation arithmetic and
 * every section of the report. The contestants' quality is NOT under test and the report
 * says so on its first page.
 */

const BASELINE = 'claude-sonnet-5'
const CHALLENGER = 'claude-fable-5-1'
const ALL_FIVES = { center: 5, craft: 5, facts: 5, age_fit: 5, continuity: 5, delight: 5 }
const BASELINE_SCORES = { center: 4, craft: 4, facts: 4, age_fit: 4, continuity: 5, delight: 3 }
const CHALLENGER_SCORES = { center: 5, craft: 5, facts: 4, age_fit: 5, continuity: 5, delight: 5 }

/**
 * Scripts the whole run in call order. The order is fixed by the protocol: §5 calibration
 * first (8 SCOREs then 2 PAIRWISE), then the bake-off's SCOREs in contestant order, then
 * its PAIRWISE pair, then the second judge on the challenger and the baseline.
 */
function scriptRun(opts: { calibrationPasses?: boolean } = {}): (info: { purpose: string }) => string {
  const calibrationPasses = opts.calibrationPasses ?? true
  let score = 0
  let pair = 0

  const sabotageScore = (
    scores: JudgeScoreWithExcerpts['scores'],
    evidence: Partial<JudgeScoreWithExcerpts['evidence']>,
  ): string =>
    scoreResponse(calibrationPasses ? scores : ALL_FIVES, {
      evidence: {
        center: 'ok',
        craft: 'ok',
        facts: 'ok',
        age_fit: 'ok',
        continuity: 'ok',
        delight: 'ok',
        ...evidence,
      },
    })

  return ({ purpose }) => {
    if (purpose === 'judge_pairwise') {
      pair += 1
      // Calibration: the original beats the sabotaged copy in both orders.
      if (pair === 1) return pairwiseResponse('A', 0.9)
      if (pair === 2) return pairwiseResponse('B', 0.9)
      // Bake-off: the challenger wins in both orders (A first, then B when swapped).
      if (pair === 3) return pairwiseResponse('A', 0.8)
      return pairwiseResponse('B', 0.75)
    }

    score += 1
    // 1-4: the four reference stories.
    if (score <= 4) return scoreResponse(ALL_FIVES)
    // 5-8: the four sabotaged variants.
    if (score === 5) {
      return sabotageScore({ ...ALL_FIVES, center: 2 }, {
        center: 'The second child is named once and never acts.',
      })
    }
    if (score === 6) {
      return sabotageScore({ ...ALL_FIVES, facts: 2 }, {
        facts: 'Three dates are wrong: 1847, 1911 and 1926.',
      })
    }
    if (score === 7) {
      return sabotageScore({ ...ALL_FIVES, age_fit: 2 }, {
        age_fit: 'A shark chases and rams the submarine; band A allows no chasing.',
      })
    }
    if (score === 8) return sabotageScore({ ...ALL_FIVES, age_fit: 3, delight: 3 }, {})
    // 9-10: the bake-off stories, in contestant order.
    if (score === 9) return scoreResponse(BASELINE_SCORES)
    if (score === 10) return scoreResponse(CHALLENGER_SCORES)
    // 11-12: the second judge, challenger then baseline.
    if (score === 11) return scoreResponse(CHALLENGER_SCORES)
    return scoreResponse(BASELINE_SCORES)
  }
}

interface RunOutcome {
  result: BakeoffResult
  sink: MemoryLogSink
}

async function runOnce(opts: { calibrationPasses?: boolean } = {}): Promise<RunOutcome> {
  const script = scriptRun(opts)
  let sink = new MemoryLogSink()
  const result = await withScriptedJudge(
    () => {
      sink = new MemoryLogSink()
      return runBakeoff({
        scenarios: ['lego-band-a-pair'],
        contestants: [BASELINE, CHALLENGER],
        samples: 1,
        baseline: BASELINE,
        // Off so the run has exactly one comparison and the script stays readable. The
        // report then carries the note that §6's decision rule is only estimated.
        pairwiseVsBest: false,
        provider: syntheticProvider(),
        sink,
      })
    },
    script,
  )
  return { result, sink }
}

describe('§7 bake-off harness: 1 scenario × 2 contestants × 1 sample in fixture mode', () => {
  it('runs the whole §6 protocol and produces a report with every section present', async () => {
    const { result } = await runOnce()

    expect(result.pipeline).toBe('fixture')
    expect(result.synthetic).toBe(true)
    expect(result.stories).toHaveLength(2)
    expect(result.comparisons).toHaveLength(1)
    expect(result.summaries).toHaveLength(2)
    expect(result.stories.every((s) => s.judge_ok)).toBe(true)

    const markdown = renderBakeoffReport(result)
    for (const section of BAKEOFF_REPORT_SECTIONS) {
      expect(markdown, `missing section: ${section}`).toContain(`## ${section}`)
    }
    expect(markdown.startsWith('# Model bake-off — ')).toBe(true)
  })

  it('writes both artifacts to eval/results/ with the §6 names', async () => {
    const { result } = await runOnce()
    const dir = mkdtempSync(join(tmpdir(), 'storytime-results-'))
    const jsonPath = writeResultFile(nextResultPath('bakeoff-', 'json', { dir }), result)
    const mdPath = writeResultFile(nextResultPath('bakeoff-', 'md', { dir }), renderBakeoffReport(result))

    expect(jsonPath).toMatch(/bakeoff-\d{4}-\d{2}-\d{2}\.json$/)
    expect(mdPath).toMatch(/bakeoff-\d{4}-\d{2}-\d{2}\.md$/)
    const reread = JSON.parse(readFileSync(jsonPath, 'utf8')) as BakeoffResult
    expect(reread.kind).toBe('bakeoff')
    expect(readFileSync(mdPath, 'utf8')).toContain('## Decision rule')

    // A second run on the same day must not overwrite the first.
    const second = writeResultFile(nextResultPath('bakeoff-', 'json', { dir }), result)
    expect(second).not.toBe(jsonPath)
    expect(second).toMatch(/-2\.json$/)
  })

  it('records the model ids and prices the run was priced with (§6)', async () => {
    const { result } = await runOnce()
    expect(Object.keys(result.models).sort()).toEqual([CHALLENGER, BASELINE].sort())
    expect(result.models[BASELINE]!.input).toBeGreaterThan(0)
    expect(result.models[BASELINE]!.output).toBeGreaterThan(0)
    expect(result.pricing_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.judge_prompt.version).toBe('judge.v2')
    expect(result.judge_prompt.sha256).toHaveLength(16)
  })

  it('ran calibration first and reports it as passed', async () => {
    const { result } = await runOnce()
    expect('skipped' in result.calibration).toBe(false)
    if ('skipped' in result.calibration) throw new Error('unreachable')
    expect(result.calibration.passed).toBe(true)
    expect(result.calibration.judge_calls).toBe(10)
    expect(renderBakeoffReport(result)).toContain('**PASS** — 10 judge calls')
  })

  it('refuses to produce any numbers when calibration fails', async () => {
    await expect(runOnce({ calibrationPasses: false })).rejects.toThrow(
      /Judge calibration failed/,
    )
  })

  it('resolves the pairwise verdict from both orders', async () => {
    const { result } = await runOnce()
    const comparison = result.comparisons[0]!
    expect(comparison.challenger).toBe(CHALLENGER)
    expect(comparison.baseline).toBe(BASELINE)
    expect(comparison.first_order_verdict).toBe('A')
    expect(comparison.swapped_order_verdict).toBe('B')
    // Both orders preferred the challenger, so it is a win and not a position flip.
    expect(comparison.verdict).toBe('A')
    expect(comparison.flipped).toBe(false)

    const challenger = result.summaries.find((s) => s.model === CHALLENGER)!
    expect(challenger.vs_baseline).toEqual({ wins: 1, ties: 0, losses: 0, avg_confidence: 0.78 })
    // The baseline has no row against itself.
    expect(result.summaries.find((s) => s.model === BASELINE)!.vs_baseline).toBeNull()
  })

  it('runs a second judge on the highest-stakes comparison and reports agreement', async () => {
    const { result } = await runOnce()
    const comparison = result.comparisons[0]!
    expect(comparison.second_judge).not.toBeNull()
    expect(comparison.second_judge!.model).toBe(modelForRole('judge_secondary'))
    expect(comparison.second_judge!.agrees_on_winner).toBe(true)
    expect(result.agreement.comparisons_double_judged).toBe(1)
    expect(result.agreement.winner_agreement_rate).toBe(1)
    expect(Number.isFinite(result.agreement.criterion_agreement_rate)).toBe(true)
  })

  it('states the self-preference caveat on a contestant that is also a judge', async () => {
    const { result } = await runOnce()
    const challenger = result.summaries.find((s) => s.model === CHALLENGER)!
    expect(challenger.is_also_a_judge).toBe(true)
    expect(result.summaries.find((s) => s.model === BASELINE)!.is_also_a_judge).toBe(false)

    const markdown = renderBakeoffReport(result)
    expect(markdown).toContain('Self-preference bias is real')
    expect(markdown).toContain('⚠️ marks a contestant that is also a judge')
    // The marker is attached to the row itself, not only to the prose.
    expect(markdown).toContain(`\`${CHALLENGER}\` ⚠️`)
    expect(markdown).not.toContain(`\`${BASELINE}\` ⚠️`)
    expect(result.notes.join(' ')).toMatch(/Both judges are also contestants/)
  })

  it('recomputes the overall and never reports the judge\'s own arithmetic', async () => {
    const { result } = await runOnce()
    for (const story of result.stories) {
      // scoreResponse() claims 1.11 on purpose.
      expect(story.overall_raw).toBe(1.11)
      expect(story.overall_final).not.toBe(1.11)
    }
    const baselineStory = result.stories.find((s) => s.contestant === BASELINE)!
    // 4*.2 + 4*.2 + 4*.2 + 4*.15 + 5*.1 + 3*.15 = 3.95, and no cap fired.
    expect(baselineStory.overall_final).toBeCloseTo(3.95, 2)
    expect(baselineStory.caps_applied).toEqual(['none'])
  })

  it('records that the fact-sourcing check could not be run', async () => {
    const { result } = await runOnce()
    for (const story of result.stories) {
      expect(story.cap_context?.factSourcing).toBe('unverifiable_no_fact_pack')
    }
  })

  it('carries the judge\'s best and worst moments into the report', async () => {
    const { result } = await runOnce()
    expect(result.stories[0]!.best_moment).toBeTruthy()
    expect(result.stories[0]!.worst_moment).toBeTruthy()
    const markdown = renderBakeoffReport(result)
    expect(markdown).toContain('**best**')
    expect(markdown).toContain('**worst**')
    expect(markdown).toContain(result.stories[0]!.best_moment!)
  })

  it('says out loud that the stories are not model output', async () => {
    const { result } = await runOnce()
    const markdown = renderBakeoffReport(result)
    expect(markdown).toContain('THIS IS NOT A BAKE-OFF RESULT')
    expect(result.notes.join(' ')).toMatch(/PIPELINE: FIXTURE/)
  })

  it('notes the limitation when the decision rule cannot be measured against the best contestant', async () => {
    const { result } = await runOnce()
    expect(result.notes.join(' ')).toMatch(/decision rule is stated as "loss rate against the best contestant"/)
  })

  it('leaks no contestant identity into the report\'s judge-facing data', async () => {
    const { result } = await runOnce()
    // The report is for the owner and names models on purpose. What must be clean is every
    // field that came back from the judge: evidence, excerpts and justifications.
    for (const story of result.stories) {
      expect(findIdentityLeaks(story.best_moment ?? '')).toEqual([])
      expect(findIdentityLeaks(story.worst_moment ?? '')).toEqual([])
    }
    for (const c of result.comparisons) {
      expect(findIdentityLeaks(c.per_criterion_first ? JSON.stringify(c.per_criterion_first) : '')).toEqual([])
    }
  })
})

describe('§7 the report\'s cost figures reconcile with generation_logs', () => {
  it('matches the sum over generation_logs within 0.1%', async () => {
    const { result, sink } = await runOnce()

    // Recomputed here from the log rows, independently of the harness's own arithmetic.
    const loggedGeneration = sink.rows
      .filter((r) => !JUDGE_PURPOSES.has(r.purpose))
      .reduce((n, r) => n + r.cost_usd, 0)
    expect(loggedGeneration).toBeGreaterThan(0)

    const reported = result.cost.generation_usd
    const delta = Math.abs(loggedGeneration - reported) / loggedGeneration
    expect(delta).toBeLessThanOrEqual(0.001)

    expect(result.cost.reconciliation.within_tolerance).toBe(true)
    expect(result.cost.reconciliation.logged_generation_usd).toBeCloseTo(loggedGeneration, 6)
    expect(result.cost.reconciliation.log_rows).toBe(sink.rows.length)
    expect(renderBakeoffReport(result)).toContain('Within the 0.1% tolerance | yes')
  })

  it('keeps judge cost out of the per-story cost', async () => {
    const { result, sink } = await runOnce()
    const judgeRows = sink.rows.filter((r) => JUDGE_PURPOSES.has(r.purpose))
    expect(judgeRows.length).toBeGreaterThan(0)
    // Every judge row is a judge purpose and none of them is inside the generation figure.
    const judgeTotal = judgeRows.reduce((n, r) => n + r.cost_usd, 0)
    expect(result.cost.generation_usd + judgeTotal).toBeCloseTo(
      sink.rows.reduce((n, r) => n + r.cost_usd, 0),
      5,
    )
    expect(result.cost.total_usd).toBeGreaterThan(result.cost.generation_usd)
  })

  it('logs one row per pipeline step, correlated to the story', async () => {
    const { sink } = await runOnce()
    const write = sink.rows.filter((r) => r.purpose === 'write')
    expect(write).toHaveLength(2)
    expect(write.map((r) => r.model).sort()).toEqual([CHALLENGER, BASELINE].sort())
    for (const row of write) expect(row.story_id).toMatch(/^bakeoff:lego-band-a-pair:/)
  })
})
