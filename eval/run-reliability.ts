/**
 * Judge test-retest reliability (step 1 of the calibration plan).
 *
 * The one property JUDGE_AGENT.md never asks for and nothing has measured: does the judge
 * give the SAME story the SAME score twice? Everything downstream depends on the answer.
 * If overall swings by more than the gaps we intend to read (Sonnet vs Opus in the bake-off
 * may differ by ~0.3), then single-sample comparisons are noise and only medians mean
 * anything - and the shark story's 3.25 may itself be partly noise.
 *
 *   LIVE_API=1 tsx eval/run-reliability.ts --repeats=3 --budget=2
 *
 * Writes eval/results/reliability-<date>.json. Costs ~$0.05 per score call.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JUDGE_CRITERIA, type JudgeCriterion } from '@/lib/schemas'
import { loadReferenceCases } from '@/lib/eval/references'
import { scoreStory } from '@/lib/eval/judge'
import { modelForRole } from '@/lib/ai/pricing'
import { MemoryLogSink } from '@/lib/ai/types'

function arg(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}

function stats(xs: number[]): { median: number; min: number; max: number; spread: number } {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const median = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
  return { median, min: s[0]!, max: s[s.length - 1]!, spread: s[s.length - 1]! - s[0]! }
}

async function main(): Promise<void> {
  const repeats = arg('repeats', 3)
  const budget = arg('budget', 0)
  const cases = loadReferenceCases()
  const judge = modelForRole('judge_primary')
  const perCall = 0.05
  const estimate = cases.length * repeats * perCall

  console.log(`Judge reliability: ${cases.length} references x ${repeats} repeats on ${judge}`)
  console.log(`  estimated $${estimate.toFixed(2)} (${cases.length * repeats} score calls)\n`)
  if (process.env.LIVE_API !== '1') {
    console.log('LIVE_API is not 1 - nothing to do. This measurement is only meaningful live.')
    return
  }
  if (budget < estimate) {
    throw new Error(`Estimated $${estimate.toFixed(2)}; re-run with --budget=${Math.ceil(estimate)}`)
  }

  const sink = new MemoryLogSink()
  const out: Record<string, unknown> = {}
  let worstSpread = 0
  let worstWhere = ''

  for (const c of cases) {
    const overalls: number[] = []
    const byCriterion: Record<string, number[]> = {}
    for (let i = 0; i < repeats; i += 1) {
      const r = await scoreStory({ context: c.context, story: c.story, sink })
      if (!r.ok || !r.final) {
        console.log(`  ${c.entry.file} run ${i + 1}: judge_error`)
        continue
      }
      overalls.push(r.final.overall)
      for (const k of JUDGE_CRITERIA) {
        byCriterion[k] ??= []
        byCriterion[k]!.push(r.final.scores[k as JudgeCriterion])
      }
    }
    const o = stats(overalls)
    if (o.spread > worstSpread) {
      worstSpread = o.spread
      worstWhere = `${c.entry.file} overall`
    }
    const critLine = JUDGE_CRITERIA.map((k) => {
      const s = stats(byCriterion[k] ?? [0])
      if (s.spread > worstSpread) {
        worstSpread = s.spread
        worstWhere = `${c.entry.file} ${k}`
      }
      return `${k}=${s.median}${s.spread ? `(±${s.spread})` : ''}`
    }).join(' ')
    console.log(
      `  ${c.entry.file.padEnd(38)} overall median ${o.median.toFixed(2)} ` +
        `range ${o.min.toFixed(2)}-${o.max.toFixed(2)} spread ${o.spread.toFixed(2)}`,
    )
    console.log(`      ${critLine}`)
    out[c.entry.file] = { overalls, byCriterion, overall: o }
  }

  const medians = Object.values(out).map((v) => (v as { overall: { median: number } }).overall.median)
  const mean = medians.reduce((a, b) => a + b, 0) / medians.length
  console.log(`\n  references mean of medians: ${mean.toFixed(3)}`)
  console.log(`  worst spread anywhere: ${worstSpread.toFixed(2)} (${worstWhere})`)
  console.log(`  actual spend: $${sink.totalCostUsd.toFixed(4)} over ${sink.rows.length} calls`)
  /**
   * Overall and per-criterion reliability are different questions and must not be collapsed.
   * The bake-off reads OVERALL, so overall spread is what decides whether its gaps are real.
   * A single noisy criterion matters for reading that criterion, not for the headline - and
   * reporting one number for both (the first version of this script did) turns a usable
   * instrument into a failed one on the strength of its weakest sub-score.
   */
  const overallSpread = Math.max(
    ...Object.values(out).map((v) => (v as { overall: { spread: number } }).overall.spread),
  )
  const noisyCriteria = JUDGE_CRITERIA.filter((k) =>
    Object.values(out).some((v) => {
      const xs = (v as { byCriterion: Record<string, number[]> }).byCriterion[k] ?? []
      return xs.length > 1 && Math.max(...xs) - Math.min(...xs) > 0
    }),
  )
  console.log(
    `\n  OVERALL spread ${overallSpread.toFixed(2)} - ` +
      (overallSpread <= 0.3
        ? `reliable. A bake-off gap above ${Math.max(0.3, overallSpread).toFixed(2)} in overall is real, not noise.`
        : `NOT reliable at the single-sample level; read medians of 3 and ignore gaps below ${overallSpread.toFixed(2)}.`),
  )
  if (noisyCriteria.length > 0) {
    console.log(
      `  Criteria that moved between identical runs: ${noisyCriteria.join(', ')}.` +
        ` Read those per-criterion numbers as medians only.`,
    )
  }

  const dir = join(process.cwd(), 'eval', 'results')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `reliability-${new Date().toISOString().slice(0, 10)}.json`)
  writeFileSync(
    path,
    JSON.stringify(
      { ran_at: new Date().toISOString(), judge_model: judge, repeats, references: out,
        mean_of_medians: mean, worst_spread: worstSpread, worst_where: worstWhere,
        cost_usd: sink.totalCostUsd },
      null, 2,
    ) + '\n',
  )
  console.log(`\nWrote ${path}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
