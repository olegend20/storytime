#!/usr/bin/env tsx
import { MeteredLogSink } from '@/lib/ai'
import { estimateEvalCost, formatEstimate } from '@/lib/eval/estimate'
import { compareEvalRuns, formatEval, runEval, type EvalResult } from '@/lib/eval/harness'
import { evalScenarios, selectScenarios } from '@/lib/eval/scenarios'
import { runCalibration, formatCalibration } from '@/lib/eval/calibration'
import {
  nextResultPath,
  previousResultPath,
  readResultFile,
  writeResultFile,
} from '@/lib/eval/results'
import { installCliCostLogging } from '@/lib/costs/cli'
import { readyFactPackTopics } from '@/lib/topics/factpack'

/**
 * `pnpm eval` - F13.
 *
 * Costs real money. It therefore does three things before it calls anything:
 *   1. prints a cost estimate computed from `config/pricing.json`;
 *   2. refuses to start a live run whose estimate exceeds the approved ceiling
 *      (CLAUDE.md: more than ~$20 in one run is a stop-and-ask);
 *   3. runs judge calibration first, and reports nothing if it fails (F13 AC).
 *
 * Flags:
 *   --dry-run            print the plan and the estimate, make no calls
 *   --calibration-only   run only the §5 calibration set and write its result file
 *   --fixture            use the fixture pipeline instead of F6 (harness development)
 *   --scenarios=a,b      subset by id (also read from EVAL_SCENARIOS)
 *   --budget=N           approve up to $N for this run (also EVAL_BUDGET_APPROVED_USD)
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

async function main(): Promise<void> {
  // Persist this run's costs to generation_logs; see lib/costs/cli.ts.
  const costLogging = installCliCostLogging()
  if (!costLogging.persisting) console.warn(`[costs] ${costLogging.reason}`)
  const scenarioSpec = value('scenarios') ?? process.env.EVAL_SCENARIOS
  if (flag('fixture')) process.env.EVAL_PIPELINE = 'fixture'
  const live = process.env.LIVE_API === '1' || process.env.LIVE_API === 'true'
  const scenarios = selectScenarios(evalScenarios(), scenarioSpec)

  const estimate = estimateEvalCost({ scenarios, builtTopics: await readyFactPackTopics() })
  console.log(formatEstimate(`pnpm eval (${scenarios.length} scenarios)`, estimate))
  console.log('')

  const approved = Number(value('budget') ?? process.env.EVAL_BUDGET_APPROVED_USD ?? '0')
  const ceiling = approved > 0 ? approved : DEFAULT_BUDGET_CEILING_USD

  if (flag('dry-run')) {
    console.log('--dry-run: no calls made.')
    console.log(`Scenarios: ${scenarios.map((s) => s.id).join(', ')}`)
    return
  }

  if (live && estimate.total_usd > ceiling) {
    console.error(
      `Refusing to start: the estimate is $${estimate.total_usd.toFixed(2)} and the approved ceiling is ` +
        `$${ceiling.toFixed(2)}.\n` +
        `CLAUDE.md: spending more than ~$${DEFAULT_BUDGET_CEILING_USD} in one run needs the owner's ` +
        `sign-off, with the number. Re-run with --budget=<approved amount> once you have it.`,
    )
    process.exitCode = 1
    return
  }

  // Counted here AND persisted: a bare MemoryLogSink passed to callModel() replaces the
  // Supabase sink, and this run's spend would never reach generation_logs.
  const sink = new MeteredLogSink()

  if (flag('calibration-only')) {
    const calibration = await runCalibration({ sink })
    const path = writeResultFile(
      nextResultPath('calibration-', 'json'),
      calibration,
    )
    console.log(formatCalibration(calibration))
    console.log(`\nWrote ${path}`)
    process.exitCode = calibration.passed ? 0 : 1
    return
  }

  let result: EvalResult
  try {
    result = await runEval({
      ...(scenarioSpec ? { scenarios: scenarioSpec } : {}),
      sink,
      onProgress: (line) => console.log(`  … ${line}`),
    })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    if (err instanceof Error && /fixture/i.test(err.message)) console.error(FIXTURE_MODE_HINT)
    process.exitCode = 1
    return
  }

  // §5: the calibration result gets its own file, whatever the eval did.
  if (!('skipped' in result.calibration)) {
    const calPath = writeResultFile(nextResultPath('calibration-', 'json'), result.calibration)
    console.log(formatCalibration(result.calibration))
    console.log(`Wrote ${calPath}`)
    console.log('')
  }

  const previousPath = previousResultPath('eval-')
  const previous = previousPath ? readResultFile<EvalResult>(previousPath) : null

  const path = writeResultFile(nextResultPath('eval-', 'json'), result)
  console.log(formatEval(result))
  console.log('')
  console.log(compareEvalRuns(result, previous))
  console.log('')
  console.log(`Wrote ${path}`)
  process.exitCode = result.summary.passed ? 0 : 1
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
