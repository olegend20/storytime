#!/usr/bin/env tsx
import { MemoryLogSink, models } from '@/lib/ai'
import { runBakeoff, type BakeoffResult } from '@/lib/eval/bakeoff'
import { estimateBakeoffCost, formatEstimate } from '@/lib/eval/estimate'
import { renderBakeoffReport } from '@/lib/eval/report'
import { nextResultPath, writeResultFile } from '@/lib/eval/results'
import { bakeoffScenarios, selectScenarios } from '@/lib/eval/scenarios'
import { installCliCostLogging } from '@/lib/costs/cli'

/**
 * `pnpm bakeoff` - F14 / JUDGE_AGENT.md §6.
 *
 * THIS IS THE EXPENSIVE ONE. A full run is 12 scenarios × 4 contestants × 3 samples
 * through the real pipeline, plus SCORE on every story, PAIRWISE in both orders, and a
 * second judge on the closest comparisons. The estimate below is computed from
 * `config/pricing.json` and printed before anything is called; a live run above the
 * approved ceiling is refused, because CLAUDE.md makes that the owner's decision and the
 * owner needs the number to make it.
 *
 * Flags:
 *   --dry-run              print the plan and the estimate, make no calls
 *   --fixture              use the fixture pipeline (harness development; not a result)
 *   --scenarios=a,b        subset by id
 *   --contestants=x,y      subset of config/models.json bakeoff_contestants
 *   --samples=N            samples per scenario × contestant (default 3)
 *   --baseline=<model>     the pairwise baseline (default: the `writer` role)
 *   --second-judge=N       how many comparisons get a second judge (default 12)
 *   --no-pairwise-vs-best  skip the extra pass §6's decision rule needs
 *   --budget=N             approve up to $N for this run
 */

const DEFAULT_BUDGET_CEILING_USD = 20

const FIXTURE_MODE_HINT = [
  '',
  'If you are running in fixture mode: the judge still needs recorded fixtures. `pnpm eval`',
  'and `pnpm bakeoff` replay real judge responses, they do not fabricate them - only the',
  'test suite does that, into a temp directory (test/helpers/judge-fixtures.ts). To get',
  'fixtures, record them once with LIVE_API=1 RECORD_FIXTURES=1 and the owner\'s approval.',
].join('\n')


function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function value(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}
function list(name: string): string[] | undefined {
  const raw = value(name)
  return raw === undefined ? undefined : raw.split(',').map((s) => s.trim()).filter(Boolean)
}

async function main(): Promise<void> {
  // Persist this run's costs to generation_logs; see lib/costs/cli.ts.
  const costLogging = installCliCostLogging()
  if (!costLogging.persisting) console.warn(`[costs] ${costLogging.reason}`)
  if (flag('fixture')) process.env.EVAL_PIPELINE = 'fixture'
  const live = process.env.LIVE_API === '1' || process.env.LIVE_API === 'true'

  const scenarioIds = list('scenarios')
  const scenarios = scenarioIds
    ? selectScenarios(bakeoffScenarios(), scenarioIds.join(','))
    : bakeoffScenarios()
  const contestants = list('contestants') ?? models.bakeoff_contestants
  const samples = Number(value('samples') ?? '3')
  const secondJudgeLimit = Number(value('second-judge') ?? '12')
  const pairwiseVsBest = !flag('no-pairwise-vs-best')
  const baseline = value('baseline')

  const estimate = estimateBakeoffCost({
    scenarios,
    contestants,
    samples,
    secondJudgeLimit,
    pairwiseVsBest,
  })
  console.log(
    formatEstimate(
      `pnpm bakeoff (${scenarios.length} scenarios × ${contestants.length} contestants × ${samples} samples)`,
      estimate,
    ),
  )
  console.log('')

  const approved = Number(value('budget') ?? process.env.EVAL_BUDGET_APPROVED_USD ?? '0')
  const ceiling = approved > 0 ? approved : DEFAULT_BUDGET_CEILING_USD

  if (flag('dry-run')) {
    console.log('--dry-run: no calls made.')
    console.log(`Scenarios:   ${scenarios.map((s) => s.id).join(', ')}`)
    console.log(`Contestants: ${contestants.join(', ')}`)
    return
  }

  if (live && estimate.total_usd > ceiling) {
    console.error(
      `Refusing to start: the estimate is $${estimate.total_usd.toFixed(2)} and the approved ceiling ` +
        `is $${ceiling.toFixed(2)}.\n` +
        `CLAUDE.md: a run above ~$${DEFAULT_BUDGET_CEILING_USD} is the owner's decision. Bring them this ` +
        `number, then re-run with --budget=<approved amount>.\n` +
        `Cheaper options: --samples=2 (drops the generation and SCORE lines by a third), ` +
        `--no-pairwise-vs-best, or --scenarios=<subset>.`,
    )
    process.exitCode = 1
    return
  }

  const sink = new MemoryLogSink()
  let result: BakeoffResult
  try {
    result = await runBakeoff({
      ...(scenarioIds ? { scenarios: scenarioIds } : {}),
      contestants,
      samples,
      secondJudgeLimit,
      pairwiseVsBest,
      ...(baseline ? { baseline } : {}),
      sink,
      onProgress: (line) => console.log(`  … ${line}`),
    })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    if (err instanceof Error && /fixture/i.test(err.message)) console.error(FIXTURE_MODE_HINT)
    process.exitCode = 1
    return
  }

  const jsonPath = writeResultFile(nextResultPath('bakeoff-', 'json'), result)
  const mdPath = writeResultFile(nextResultPath('bakeoff-', 'md'), renderBakeoffReport(result))

  if (!('skipped' in result.calibration)) {
    writeResultFile(nextResultPath('calibration-', 'json'), result.calibration)
  }

  console.log('')
  console.log(`Stories: ${result.stories.length}   Comparisons: ${result.comparisons.length}`)
  console.log(
    `Cost: $${result.cost.total_usd.toFixed(4)} ` +
      `($${result.cost.generation_usd.toFixed(4)} generation + $${result.cost.judge_usd.toFixed(4)} judging)`,
  )
  console.log(
    `Cost reconciliation vs generation_logs: ${result.cost.reconciliation.delta_pct.toFixed(4)}% ` +
      `(${result.cost.reconciliation.within_tolerance ? 'within' : 'OUTSIDE'} the 0.1% tolerance)`,
  )
  console.log(`Wrote ${jsonPath}`)
  console.log(`Wrote ${mdPath}`)
  if (result.synthetic) {
    console.log('')
    console.log('** FIXTURE PIPELINE: these are harness numbers, not a bake-off result. **')
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
