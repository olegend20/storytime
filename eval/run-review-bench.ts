#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MeteredLogSink, modelForRole } from '@/lib/ai'
import { formatEstimate } from '@/lib/eval/estimate'
import { writeFirstDraft } from '@/lib/eval/live-pipeline'
import { loadPrompt } from '@/lib/prompts'
import {
  estimateBuildCost,
  estimateRunCost,
  formatBench,
  runBench,
  summarizeBench,
  type BenchItem,
  type BenchLabel,
  type BenchRun,
  type BenchSet,
  type ReviewerSettings,
} from '@/lib/eval/review-bench'
import { nextResultPath, readResultFile, RESULTS_DIR, writeResultFile } from '@/lib/eval/results'
import { evalScenarios, getScenario, scenarioSplit, selectScenarios } from '@/lib/eval/scenarios'
import { installCliCostLogging } from '@/lib/costs/cli'

/**
 * `pnpm review-bench` - issue #58. Costs real money, so like `pnpm eval` it prints an
 * estimate first and refuses a live run above the approved ceiling.
 *
 *   --build               write the frozen set: every golden-set scenario's first draft,
 *                         stopped at the gate (~$0.16 a draft)
 *   --set=PATH            score a reviewer prompt on that set (~$0.009 a review)
 *   --candidate=DIR       a directory holding `quality-review.v<N>.md` to score instead of
 *                         the shipped prompt
 *   --labels=PATH         hand labels, `[{ id, should_pass, notes }]`
 *   --model=ID            the reviewer model (default: the configured quality_reviewer)
 *   --effort=low|medium|high, --thinking=off   reviewer settings, for models that take them
 *   --label=NAME          a short name for the candidate, used in the result file name
 *   --samples=N           reviews per draft (default 3)
 *   --split=train|test    only the golden set's train or test half: tune on train, score
 *                         the winner on test once
 *   --scenarios=a,b       subset (also split:train / split:test), for --build
 *   --dry-run             print the estimate, make no calls
 *   --budget=N            approve up to $N (default ceiling $10)
 *
 * Scoring the WRITER (DECISIONS #202): build a set with the candidate writer prompt (the
 * newest `prompts/master.v<N>.md`; `PROMPT_PIN_MASTER=<N>` pins another), label it, then
 * score it with the shipped reviewer, no labels needed. The run prints how many first drafts
 * the reviewer passes, which judgement fails the rest, and the free deterministic checks:
 *
 *   pnpm review-bench --build --scenarios=split:train --label=master-v6
 *   pnpm review-bench --set=eval/review-bench/set-master-v6-<date>.json --samples=3
 */

const DEFAULT_CEILING_USD = 10
const BENCH_DIR = join(RESULTS_DIR, '..', 'review-bench')

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function value(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}

function withinCeiling(total: number): boolean {
  const approved = Number(value('budget') ?? '0')
  const ceiling = approved > 0 ? approved : DEFAULT_CEILING_USD
  if (total <= ceiling) return true
  console.error(
    `Refusing to start: the estimate is $${total.toFixed(2)} and the approved ceiling is $${ceiling.toFixed(2)}. ` +
      'Re-run with --budget=<approved amount> once the owner has approved it.',
  )
  process.exitCode = 1
  return false
}

async function build(sink: MeteredLogSink): Promise<void> {
  const scenarios = selectScenarios(evalScenarios(), value('scenarios'))
  const writer = modelForRole('writer')
  const estimate = estimateBuildCost(scenarios.length, writer)
  console.log(formatEstimate(`review-bench --build (${scenarios.length} drafts)`, estimate))
  if (flag('dry-run') || !withinCeiling(estimate.total_usd)) return

  const items: BenchItem[] = []
  let cost = 0
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < scenarios.length) {
      const scenario = scenarios[next++]!
      try {
        const draft = await writeFirstDraft({ scenario, writingModel: writer, sample: 1, sink, storyId: randomUUID() })
        items.push({ id: scenario.id, scenario_id: scenario.id, story: draft.story, request: draft.request, fact_pack: draft.factPack })
        cost += draft.costUsd
        console.log(`  … ${scenario.id}: ${draft.writeCalls} write(s), $${draft.costUsd.toFixed(3)}`)
      } catch (err) {
        console.warn(`  … ${scenario.id}: no draft (${err instanceof Error ? err.message : String(err)})`)
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  items.sort((a, b) => a.id.localeCompare(b.id))
  const master = loadPrompt('master')
  const set: BenchSet = {
    kind: 'review-bench-set',
    created_at: new Date().toISOString(),
    writer_model: writer,
    writer_prompt: { id: master.id, version: master.version },
    build_cost_usd: cost,
    items,
  }
  const tag = value('label')
  const path = writeResultFile(nextResultPath(`set-${tag ? `${tag}-` : ''}`, 'json', { dir: BENCH_DIR }), set)
  console.log(`\n${items.length}/${scenarios.length} drafts, $${cost.toFixed(2)}. Wrote ${path}`)
}

async function score(setPath: string, sink: MeteredLogSink): Promise<void> {
  const full = readResultFile<BenchSet>(setPath)
  // Tune on split:train; score the winner on split:test once (the golden set's halves, #48).
  const split = value('split')
  const set: BenchSet = split
    ? { ...full, items: full.items.filter((i) => scenarioSplit(getScenario(i.scenario_id)) === split) }
    : full
  const samples = Number(value('samples') ?? '3')
  const model = value('model')
  const effort = value('effort') as ReviewerSettings['effort']
  const thinking = value('thinking') as ReviewerSettings['thinking']
  const reviewer: ReviewerSettings = { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(thinking ? { thinking } : {}) }
  const estimate = estimateRunCost(set.items.length, samples, model ?? modelForRole('quality_reviewer'), reviewer)
  console.log(formatEstimate(`review-bench (${set.items.length} drafts × ${samples})`, estimate))
  if (flag('dry-run') || !withinCeiling(estimate.total_usd)) return

  const labelsPath = value('labels')
  const labels = labelsPath ? readResultFile<BenchLabel[]>(labelsPath) : null
  const promptDir = value('candidate')
  const { prompt, reviews } = await runBench(set, {
    reviewer,
    ...(promptDir ? { promptDir } : {}),
    samples,
    sink,
    onProgress: (done, of) => {
      if (done % 10 === 0 || done === of) console.log(`  … ${done}/${of}`)
    },
  })
  const run: BenchRun = {
    kind: 'review-bench-run',
    ran_at: new Date().toISOString(),
    set: split ? `${setPath} (split:${split})` : setPath,
    prompt: { ...prompt, dir: promptDir ?? 'prompts' },
    reviewer: { model: model ?? modelForRole('quality_reviewer'), ...(effort ? { effort } : {}), ...(thinking ? { thinking } : {}) },
    samples,
    labelled: labels !== null,
    summary: summarizeBench(reviews, labels, set.items),
    reviews,
  }
  // Named by what was scored, so runs on the same day cannot be mixed up.
  const tag = [value('label'), model, effort, thinking === 'off' ? 'nothink' : undefined, split].filter(Boolean).join('-')
  const path = writeResultFile(nextResultPath(`run-${prompt.id}-v${prompt.version}-${tag ? `${tag}-` : ''}`, 'json', { dir: BENCH_DIR }), run)
  console.log(`\n${formatBench(run)}\n\nWrote ${path}`)
}

async function main(): Promise<void> {
  const costLogging = installCliCostLogging()
  if (!costLogging.persisting) console.warn(`[costs] ${costLogging.reason}`)
  const sink = new MeteredLogSink()
  const setPath = value('set')
  if (flag('build')) await build(sink)
  else if (setPath) await score(setPath, sink)
  else {
    console.error('Give --build, or --set=PATH to score a reviewer prompt.')
    process.exitCode = 1
  }
}

void main()
