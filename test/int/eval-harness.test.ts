import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryLogSink, ModelCallError } from '@/lib/ai'
import { EVAL_PASS_CRITERIA } from '@/lib/schemas'
import {
  compareEvalRuns,
  formatEval,
  runEval,
  type EvalResult,
  calibrationReusable,
  isInfrastructureFailure,
} from '@/lib/eval/harness'
import {
  nextResultPath,
  previousResultPath,
  readResultFile,
  writeResultFile,
} from '@/lib/eval/results'
import {
  PipelineUnavailableError,
  createFixturePipeline,
  loadLivePipeline,
  pipelineModeFromEnv,
  storyFixturePath,
  type StoryProvider,
} from '@/lib/eval/pipeline'
import { syntheticProvider } from '@/lib/eval/synthetic'
import { evalScenarios } from '@/lib/eval/scenarios'
import { pairwiseResponse, scoreResponse, withScriptedJudge } from '../helpers/judge-fixtures'
import type { JudgeScoreWithExcerpts } from '@/lib/eval/judge'
import type { CalibrationResult } from '@/lib/eval/calibration'

/**
 * F13 - the eval harness end to end in fixture mode.
 *
 * "The harness itself is the test" (F13 VT), so this exercises the whole of it: the
 * calibration gate, the eight scenarios, the F13 acceptance checks (word count, continuity
 * reference in chapter 1, scary level), the pass criteria, the results file and the
 * comparison against the previous run.
 *
 * What it cannot test is the stories, because F6 has not landed. The synthetic pipeline
 * stands in, and every artifact it produces is stamped `synthetic: true`.
 */

const ALL_FIVES = { center: 5, craft: 5, facts: 5, age_fit: 5, continuity: 5, delight: 5 }

function script(opts: { scenarioScores?: JudgeScoreWithExcerpts['scores'][] } = {}) {
  let score = 0
  let pair = 0
  const sabotage = (
    scores: JudgeScoreWithExcerpts['scores'],
    evidence: Partial<JudgeScoreWithExcerpts['evidence']>,
  ): string =>
    scoreResponse(scores, {
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

  return ({ purpose }: { purpose: string }): string => {
    if (purpose === 'judge_pairwise') {
      pair += 1
      return pairwiseResponse(pair === 1 ? 'A' : 'B', 0.9)
    }
    score += 1
    if (score <= 4) return scoreResponse(ALL_FIVES)
    if (score === 5) return sabotage({ ...ALL_FIVES, center: 2 }, { center: 'named once, never acts' })
    if (score === 6) {
      return sabotage({ ...ALL_FIVES, facts: 2 }, { facts: 'wrong years 1847, 1911, 1926' })
    }
    if (score === 7) {
      return sabotage({ ...ALL_FIVES, age_fit: 2 }, { age_fit: 'the shark chases and rams them' })
    }
    if (score === 8) return sabotage({ ...ALL_FIVES, age_fit: 3, delight: 3 }, {})
    const scenarioScores = opts.scenarioScores
    const at = score - 9
    return scoreResponse(scenarioScores?.[at] ?? scenarioScores?.[0] ?? ALL_FIVES)
  }
}

interface Outcome {
  result: EvalResult
  sink: MemoryLogSink
}

async function runOnce(
  opts: { scenarioScores?: JudgeScoreWithExcerpts['scores'][]; scenarios?: string } = {},
): Promise<Outcome> {
  const responder = script(opts)
  let sink = new MemoryLogSink()
  const result = await withScriptedJudge(
    () => {
      sink = new MemoryLogSink()
      return runEval({
        ...(opts.scenarios ? { scenarios: opts.scenarios } : {}),
        provider: syntheticProvider(),
        sink,
      })
    },
    responder,
  )
  return { result, sink }
}

describe('F13 eval harness', () => {
  it('runs all eight scenarios, gated on calibration', async () => {
    const { result } = await runOnce()

    expect(result.kind).toBe('eval')
    expect(result.pipeline).toBe('fixture')
    expect(result.synthetic).toBe(true)
    expect(result.scenarios).toHaveLength(8)
    expect(result.scenarios.map((s) => s.scenario_id)).toEqual(evalScenarios().map((s) => s.id))
    expect('skipped' in result.calibration).toBe(false)
    if ('skipped' in result.calibration) throw new Error('unreachable')
    expect(result.calibration.passed).toBe(true)
    expect(result.judge_prompt.version).toBe('judge.v2')
  })

  // eval-2026-10-06 died on scenario 2 of 8 when the writer produced no story, after $2.27.
  it('a scenario whose story cannot be made is the worst result, not the end of the run', async () => {
    const base = syntheticProvider()
    const provider: StoryProvider = async (input) => {
      if (input.scenario.id === 'video-games-band-c-solo') {
        // The write and the repair were paid for before the story was given up on.
        for (const [purpose, cost] of [['write', 0.26], ['repair', 0.02]] as const) {
          await input.sink?.write({
            // Tagged like the live pipeline's rows: with the story's own uuid, not `eval:<scenario>`.
            purpose, model: input.writingModel, story_id: '00000000-0000-4000-8000-0000000000aa', family_id: null, fact_pack_id: null,
            input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
            cost_usd: cost, latency_ms: 1, ok: false, error: 'repair_failed',
          })
        }
        throw new Error('story output unusable: repair_failed')
      }
      return base(input)
    }
    let sink = new MemoryLogSink()
    const result = await withScriptedJudge(
      () => {
        sink = new MemoryLogSink()
        return runEval({ provider, sink })
      },
      script({}),
    )
    expect(result.scenarios).toHaveLength(8)
    const failed = result.scenarios.find((r) => r.scenario_id === 'video-games-band-c-solo')!
    expect(failed.judge_ok).toBe(false)
    expect(failed.judge_error).toMatch(/no story: story output unusable/)
    expect(failed.overall_final).toBe(1)
    expect(failed.disqualified).toBe(true)
    expect(failed.caps_applied).toEqual(['no_story:overall=1'])
    expect(failed.generation_cost_usd).toBeCloseTo(0.28, 6)
    expect(result.cost.generation_usd).toBeGreaterThanOrEqual(0.28)
    expect(result.summary.disqualified).toBe(1)
    expect(result.summary.passed).toBe(false)
    expect(result.scenarios.filter((r) => r.judge_ok)).toHaveLength(7)
    // A story that was never made made no judge call: it is not also a judge error.
    expect(result.summary.judge_errors).toBe(0)
  })

  it('a scenario the API would not run is not the writer\'s fault: not scored, not disqualified, still a failed run', async () => {
    const base = syntheticProvider()
    const provider: StoryProvider = async (input) => {
      if (input.scenario.id === 'titanic-band-b') {
        throw new ModelCallError('classify_input call failed: 400 credit balance is too low', {
          purpose: 'classify_input', model: 'claude-haiku-4-5-20251001', attempts: 1, retryable: false, status: 400,
        })
      }
      if (input.scenario.id === 'bees-band-a-5min') throw new Error('produced no story: status failed: status=529 write stream failed: overloaded_error')
      return base(input)
    }
    const result = await withScriptedJudge(() => runEval({ provider, sink: new MemoryLogSink() }), script({}))
    const titanic = result.scenarios.find((r) => r.scenario_id === 'titanic-band-b')!
    expect(titanic.caps_applied).toEqual(['not_run:infrastructure'])
    expect(titanic.overall_final).toBeNull()
    expect(titanic.disqualified).toBe(false)
    expect(titanic.judge_error).toMatch(/^not run: /)
    expect(result.summary.not_run).toEqual(['bees-band-a-5min', 'titanic-band-b'])
    expect(result.summary.disqualified).toBe(0)
    // The six that ran are the mean; the run still fails, because two books were not delivered.
    expect(result.summary.scored).toBe(6)
    expect(result.summary.mean_overall).toBe(5)
    expect(result.summary.passed).toBe(false)
    expect(result.summary.failures.join(' ')).toMatch(/not run \(the API, not the writer\): bees-band-a-5min, titanic-band-b/)
    expect(isInfrastructureFailure(new Error('story output unusable: repair_failed'))).toBe(false)
    // The word alone, inside a writer failure, is not the API's word.
    expect(isInfrastructureFailure(new Error('story output unusable: repair_failed; issues: the shark was overloaded with rate limit jokes'))).toBe(false)
    // The live pipeline wraps the cause into its own message; the cause still decides.
    expect(
      isInfrastructureFailure(
        new Error('eval scenario space-race produced no story: status failed: write stream to claude-sonnet-5 failed: Your credit balance is too low'),
      ),
    ).toBe(true)
    expect(
      isInfrastructureFailure(new Error('eval scenario x produced no story: status failed: story output unusable: repair_failed:schema_invalid')),
    ).toBe(false)
    // A 5xx whose text says nothing more still reads as the API's.
    expect(isInfrastructureFailure(new Error('produced no story: status failed: status=529 write stream failed'))).toBe(true)
    expect(isInfrastructureFailure(new Error('produced no story: status failed: status=400 output_config invalid'))).toBe(false)
  })

  it('a calibration that passed today is handed over at once and can be reused by the next run', async () => {
    let handed: CalibrationResult | null = null
    const first = await withScriptedJudge(
      () => runEval({ provider: syntheticProvider(), sink: new MemoryLogSink(), onCalibration: (c) => { handed = c } }),
      script({}),
    )
    expect(handed).not.toBeNull()
    if ('skipped' in first.calibration) throw new Error('unreachable')
    expect(handed!.passed).toBe(true)
    expect(handed!.judge_prompt.sha256).toBe(first.calibration.judge_prompt.sha256)

    // The second run spends nothing on calibration: only the eight SCORE calls are made.
    // (withScriptedJudge re-runs the function once per missing fixture, so the sink is made
    // inside it and the last run's rows are the ones counted.)
    let sink = new MemoryLogSink()
    const second = await withScriptedJudge(
      () => {
        sink = new MemoryLogSink()
        return runEval({ provider: syntheticProvider(), sink, reuseCalibration: handed! })
      },
      () => scoreResponse(ALL_FIVES),
    )
    if ('skipped' in second.calibration) throw new Error('unreachable')
    expect(second.calibration.passed).toBe(true)
    expect(second.calibration.notes).toContain('reused from an earlier run today')
    // (the synthetic provider logs the pretend generation calls too; the judge's are the point)
    expect(sink.rows.filter((r) => r.purpose === 'judge_pairwise')).toHaveLength(0)
    expect(sink.rows.filter((r) => r.purpose === 'judge_score')).toHaveLength(8)
    // Paid for by the first run: this run's cost record carries none of it.
    expect(second.calibration.cost_usd).toBe(0)
    expect(second.calibration.judge_calls).toBe(0)
    const scoreCost = second.scenarios.reduce((n, r) => n + r.judge_cost_usd, 0)
    expect(second.cost.judge_usd).toBeCloseTo(scoreCost, 6)
    expect(first.cost.judge_usd).toBeGreaterThan(scoreCost)

    // Not reused: another judge prompt, a failed one, another judge model, another day.
    const good = handed!
    for (const [why, bad] of [
      ['prompt', { ...good, judge_prompt: { ...good.judge_prompt, sha256: 'deadbeef' } }],
      ['failed', { ...good, passed: false }],
      ['model', { ...good, judge_model: 'claude-haiku-4-5-20251001' }],
      ['day', { ...good, ran_at: '2026-09-28T20:00:00.000Z' }],
    ] as const) {
      expect(calibrationReusable(bad, good.judge_prompt.sha256), why).not.toBeNull()
    }
    expect(calibrationReusable(good, good.judge_prompt.sha256)).toBeNull()
    const third = await withScriptedJudge(
      () => runEval({ provider: syntheticProvider(), sink: new MemoryLogSink(), reuseCalibration: { ...good, ran_at: '2026-09-28T20:00:00.000Z' } }),
      script({}),
    )
    if ('skipped' in third.calibration) throw new Error('unreachable')
    expect(third.calibration.notes).not.toContain('reused from an earlier run today')
    expect(third.calibration.cost_usd).toBeGreaterThan(0)
  })

  it('reports nothing at all when calibration fails', async () => {
    let calls = 0
    await expect(
      withScriptedJudge(
        () => runEval({ provider: syntheticProvider(), sink: new MemoryLogSink() }),
        ({ purpose }) => {
          calls += 1
          // A judge that scores everything 5 fails every sabotage row.
          return purpose === 'judge_pairwise' ? pairwiseResponse('TIE', 0.9) : scoreResponse(ALL_FIVES)
        },
      ),
    ).rejects.toThrow(/Judge calibration failed/)
    // It stopped during calibration and never got to the scenarios.
    expect(calls).toBeLessThanOrEqual(10)
  })

  it('applies the F13 pass criteria', async () => {
    const { result } = await runOnce()
    expect(result.pass_criteria).toEqual(EVAL_PASS_CRITERIA)
    expect(result.summary.mean_overall).toBe(5)
    expect(result.summary.min_overall).toBe(5)
    expect(result.summary.disqualified).toBe(0)
    expect(result.summary.judge_errors).toBe(0)
    expect(result.summary.failures).toEqual([])
    expect(result.summary.passed).toBe(true)
  })

  it('fails when the mean is below 4.0 or any scenario is below 3.5', async () => {
    const weak = { center: 3, craft: 3, facts: 3, age_fit: 3, continuity: 3, delight: 3 }
    const { result } = await runOnce({ scenarioScores: [weak] })
    expect(result.summary.mean_overall).toBeCloseTo(3, 2)
    expect(result.summary.passed).toBe(false)
    expect(result.summary.failures.join(' ')).toMatch(/mean overall 3.00 < 4/)
    expect(result.summary.failures.join(' ')).toMatch(/lowest scenario/)
    expect(result.summary.worst_scenario).toBeTruthy()
  })

  it('checks every word count against the band range (F13 AC)', async () => {
    const { result } = await runOnce()
    for (const s of result.scenarios) {
      expect(s.word_count_in_range, `${s.scenario_id} at ${s.word_count} words`).toBe(true)
      expect(s.word_count).toBeGreaterThan(0)
    }
    expect(result.summary.word_count_failures).toEqual([])
  })

  it('checks that continuity scenarios reference a prior recurring element in chapter 1 (F13 AC)', async () => {
    const { result } = await runOnce()
    const continuity = result.scenarios.filter((s) => s.continuity_reference !== null)
    expect(continuity.map((s) => s.scenario_id)).toEqual([
      'sharks-band-a-continuity',
      'soccer-band-c-continuity',
    ])
    for (const s of continuity) {
      expect(s.continuity_reference!.required.length).toBeGreaterThan(0)
      expect(s.continuity_reference!.found.length, s.scenario_id).toBeGreaterThan(0)
      expect(s.continuity_reference!.ok).toBe(true)
    }
    expect(result.summary.continuity_failures).toEqual([])
  })

  it('leaves the titanic scary-level check UNVERIFIED rather than passed while F7 is missing', async () => {
    const { result } = await runOnce()
    const titanic = result.scenarios.find((s) => s.scenario_id === 'titanic-band-b')!
    expect(titanic.band).toBe('B')
    expect(titanic.scary_level_check).not.toBeNull()
    expect(titanic.scary_level_check!.max).toBe(1)
    // The synthetic gate emits no scary_level, so this is null - not true.
    expect(titanic.scary_level_check!.observed).toBeNull()
    expect(titanic.scary_level_check!.ok).toBeNull()
    expect(result.summary.scary_level_failures).toEqual([])
    expect(result.notes.join(' ')).toMatch(/scary-level checks are UNVERIFIED, not passed/)
    expect(result.notes.join(' ')).toContain('titanic-band-b')
  })

  it('flags a scary level above the band limit when the gate does report one', async () => {
    const responder = script()
    const result = await withScriptedJudge(
      () =>
        runEval({
          scenarios: 'titanic-band-b',
          sink: new MemoryLogSink(),
          provider: async (input) => {
            const base = await syntheticProvider()(input)
            if (!base) throw new Error('unreachable')
            return { ...base, gate: { ...base.gate, scary_level: 3 } }
          },
        }),
      responder,
    )
    const titanic = result.scenarios[0]!
    expect(titanic.scary_level_check!.observed).toBe(3)
    expect(titanic.scary_level_check!.ok).toBe(false)
    expect(result.summary.scary_level_failures).toEqual(['titanic-band-b'])
    expect(result.summary.passed).toBe(false)
  })

  it('records that the fact-sourcing check could not be run', async () => {
    const { result } = await runOnce()
    for (const s of result.scenarios) {
      expect(s.cap_context?.factSourcing).toBe('unverifiable_no_fact_pack')
    }
    expect(result.notes.join(' ')).toMatch(/unsourced_fact/)
  })

  it('says out loud that the stories are not model output', async () => {
    const { result } = await runOnce()
    expect(result.notes.join(' ')).toMatch(/PIPELINE: FIXTURE/)
    expect(formatEval(result)).toMatch(/SYNTHETIC: not an eval result/)
  })

  it('accounts for its own cost and keeps judging out of the generation figure', async () => {
    const { result, sink } = await runOnce()
    expect(result.cost.generation_usd).toBeGreaterThan(0)
    expect(result.cost.judge_usd).toBeGreaterThan(0)
    expect(result.cost.total_usd).toBeCloseTo(
      result.cost.generation_usd + result.cost.judge_usd,
      6,
    )
    const logged = sink.rows
      .filter((r) => r.purpose !== 'judge_score' && r.purpose !== 'judge_pairwise')
      .reduce((n, r) => n + r.cost_usd, 0)
    expect(Math.abs(logged - result.cost.generation_usd) / logged).toBeLessThanOrEqual(0.001)
  })

  it('carries the editor notes the judge asked for', async () => {
    const { result } = await runOnce()
    for (const s of result.scenarios) expect(s.editor_notes).toHaveLength(3)
  })
})

describe('F13: eval/results/<date>.json and the comparison against the previous run', () => {
  it('writes the results file and compares against the previous one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'storytime-eval-results-'))
    const { result: first } = await runOnce()
    const firstPath = writeResultFile(nextResultPath('eval-', 'json', { dir, date: '2026-09-01' }), first)
    expect(existsSync(firstPath)).toBe(true)

    const weak = { center: 3, craft: 4, facts: 4, age_fit: 4, continuity: 5, delight: 4 }
    const { result: second } = await runOnce({ scenarioScores: [weak] })

    const previousPath = previousResultPath('eval-', { dir })
    expect(previousPath).toBe(firstPath)
    const previous = readResultFile<EvalResult>(previousPath!)

    const comparison = compareEvalRuns(second, previous)
    // The comparison names the previous run's own date, not the filename it was stored under.
    expect(comparison).toContain(`Comparison against ${previous.date}`)
    expect(comparison).toMatch(/mean overall: 3\.90 \(-1\.10\)/)
    // Every scenario dropped by more than 0.3, so every line is marked a regression.
    expect(comparison).toMatch(/regression/)
    for (const s of second.scenarios) expect(comparison).toContain(s.scenario_id)
  })

  it('says so plainly when there is no previous run', async () => {
    const { result } = await runOnce()
    expect(compareEvalRuns(result, null)).toMatch(/No previous run/)
  })

  it('warns when the judge prompt changed between runs', async () => {
    const { result } = await runOnce()
    const stale: EvalResult = {
      ...result,
      date: '2026-08-01',
      judge_prompt: { version: 'judge.v1', sha256: 'deadbeefdeadbeef' },
    }
    expect(compareEvalRuns(result, stale)).toMatch(/judge prompt changed/)
  })

  it('does not overwrite an existing result file for the same day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'storytime-eval-results-'))
    const { result } = await runOnce()
    const a = writeResultFile(nextResultPath('eval-', 'json', { dir, date: '2026-09-02' }), result)
    const b = writeResultFile(nextResultPath('eval-', 'json', { dir, date: '2026-09-02' }), result)
    expect(b).not.toBe(a)
    expect(b).toMatch(/eval-2026-09-02-2\.json$/)
  })
})

describe('F13 VT: the eval is wired as a manual GitHub Action', () => {
  const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'eval.yml'), 'utf8')

  it('is workflow_dispatch only, so it never runs itself and spends money', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m)
  })

  it('runs pnpm eval with LIVE_API and passes the scenario input through', () => {
    expect(workflow).toContain('pnpm eval')
    expect(workflow).toMatch(/LIVE_API:\s*'1'/)
    expect(workflow).toContain('EVAL_SCENARIOS: ${{ inputs.scenarios }}')
  })

  it('uploads the results file as an artifact, even on failure', () => {
    expect(workflow).toContain('actions/upload-artifact')
    expect(workflow).toContain('path: eval/results/')
    expect(workflow).toContain('if: always()')
  })
})

describe('the F6 seam', () => {
  it('either lane 2 has landed the contract, or the failure is actionable', async () => {
    // F13 depends on F6. This test is deliberately two-sided so it stays meaningful on both
    // sides of that landing: today it asserts the error explains itself; once `lib/generate`
    // exports `createEvalPipeline()` it asserts the shape the harness needs.
    try {
      const pipeline = await loadLivePipeline()
      expect(pipeline.kind).toBe('live')
      expect(typeof pipeline.generate).toBe('function')
      expect(typeof pipeline.describe).toBe('string')
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineUnavailableError)
      expect((err as Error).message).toMatch(/F13 depends on F6/)
      expect((err as Error).message).toMatch(/EVAL_PIPELINE=fixture/)
      expect((err as Error).message).toMatch(/its scores are NOT eval results/)
    }
  })

  it('fixture mode is opt-in through EVAL_PIPELINE, never the default', () => {
    const env = (v?: string): NodeJS.ProcessEnv =>
      ({ ...(v === undefined ? {} : { EVAL_PIPELINE: v }) }) as NodeJS.ProcessEnv
    expect(pipelineModeFromEnv(env())).toBe('live')
    expect(pipelineModeFromEnv(env('fixture'))).toBe('fixture')
    expect(pipelineModeFromEnv(env('anything-else'))).toBe('live')
  })

  it('names the fixture file it wanted when there is none', async () => {
    const pipeline = createFixturePipeline({ dir: '/nonexistent-eval-fixtures' })
    const input = {
      scenario: evalScenarios()[0]!,
      writingModel: 'claude-sonnet-5',
      sample: 2,
      storyId: 'x',
    }
    await expect(pipeline.generate(input)).rejects.toThrow(
      storyFixturePath(input, '/nonexistent-eval-fixtures'),
    )
    expect(storyFixturePath(input, '/d')).toBe('/d/lego-band-a-pair.claude-sonnet-5.2.json')
  })
})
