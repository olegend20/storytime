#!/usr/bin/env tsx
import { join } from 'node:path'
import { MeteredLogSink } from '@/lib/ai'
import { installCliCostLogging } from '@/lib/costs/cli'
import { readResultFile, nextResultPath, RESULTS_DIR, writeResultFile } from '@/lib/eval/results'
import type { BenchSet } from '@/lib/eval/review-bench'
import { getScenario, scenarioSplit } from '@/lib/eval/scenarios'
import { mendStory } from '@/lib/generate/mend'
import { onlyHardRuleBreaches } from '@/lib/generate/pipeline'
import { GuardrailsSafetyReviewer } from '@/lib/generate/production-deps'
import { reviseInRounds, reviseStory } from '@/lib/generate/revise'
import { runQualityGate } from '@/lib/quality/gate'
import type { StoryOutput } from '@/lib/schemas'

/**
 * `pnpm tsx eval/run-revise-bench.ts --set=PATH` - issue #85. On a frozen set of first drafts
 * (the review bench's), runs what production runs after attempt 1: the whole gate, the mend
 * for a hard-rule-only breach, then the in-place revision, each followed by the whole gate
 * again. Reports how many drafts would still need a full rewrite, and how much text changed.
 * About $0.05-0.10 a failing draft (two or three gates and one writer call); no judge.
 *
 *   --set=PATH         a review-bench set (eval/review-bench/set-*.json)
 *   --split=train|test only that half of the golden set
 *   --model=ID         the revising model (default: the writer role)
 *   --label=NAME       a short name for the result file
 */

function value(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}

interface Row {
  id: string
  first: 'pass' | 'rewrite'
  outcome: 'pass' | 'mended' | 'revised' | 'rewrite'
  first_reasons: string[]
  left_reasons: string[]
  edits: number
  rejected: number
  changed_share: number
  cost_usd: number
  rounds?: number
  proposed?: number
  stop_reason?: string | null
  raw?: string
}

function chars(story: StoryOutput): number {
  return story.chapters.reduce((n, c) => n + c.text.length, 0)
}

async function main(): Promise<void> {
  const costLogging = installCliCostLogging()
  if (!costLogging.persisting) console.warn(`[costs] ${costLogging.reason}`)
  const setPath = value('set')
  if (!setPath) throw new Error('give --set=PATH')
  const full = readResultFile<BenchSet>(setPath)
  const split = value('split')
  const items = split ? full.items.filter((i) => scenarioSplit(getScenario(i.scenario_id)) === split) : full.items
  const model = value('model')
  const safetyReviewer = new GuardrailsSafetyReviewer()
  const rows: Row[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!
      const sink = new MeteredLogSink()
      const gateOf = (story: StoryOutput) =>
        runQualityGate({ story, request: item.request, factPack: item.fact_pack, attempt: 1, reviewDespiteFailures: true, safetyReviewer, sink })
      try {
        let story = item.story
        let gate = await gateOf(story)
        const first = gate.needsRewrite ? 'rewrite' : 'pass'
        const firstReasons = gate.result.rewrite_reasons
        let outcome: Row['outcome'] = first === 'pass' ? 'pass' : 'rewrite'
        let edits = 0
        let rejected = 0
        if (gate.needsRewrite && onlyHardRuleBreaches(gate.result, item.request.age_band)) {
          const m = await mendStory(story, gate.result.hard_violations, { sink })
          if (m.edits > 0) {
            story = m.story
            gate = await gateOf(story)
            if (!gate.needsRewrite) outcome = 'mended'
          }
        }
        let changed = 0
        let rounds = 0
        let diag: Pick<Row, 'proposed' | 'stop_reason' | 'raw'> = {}
        if (gate.needsRewrite) {
          let last: Awaited<ReturnType<typeof reviseStory>> | null = null
          const r = await reviseInRounds(story, gate, {
            revise: async (s, result) => {
              last = await reviseStory(s, result, item.request, item.fact_pack, {
                ...(model ? { model } : {}),
                ...(value('effort') ? { effort: value('effort') as 'low' | 'medium' | 'high' } : {}),
                sink,
              })
              rejected += last.rejected
              return last
            },
            regate: gateOf,
            rounds: Number(value('rounds') ?? '2'),
          })
          edits = r.edits
          changed = r.changedChars
          rounds = r.rounds
          gate = r.gate
          if (r.passed) outcome = 'revised'
          const l = last as Awaited<ReturnType<typeof reviseStory>> | null
          if (l) diag = { proposed: l.proposed, stop_reason: l.stopReason, ...(r.edits === 0 ? { raw: l.text.slice(0, 4000) } : {}) }
        }
        const row: Row = {
          id: item.id,
          first,
          outcome,
          first_reasons: firstReasons,
          left_reasons: outcome === 'rewrite' ? gate.result.rewrite_reasons : [],
          edits,
          rejected,
          changed_share: changed / chars(item.story),
          cost_usd: sink.totalCostUsd,
          rounds,
          ...diag,
        }
        rows.push(row)
        console.log(`  … ${item.id}: ${first} -> ${outcome} (${edits} edits in ${row.rounds} round(s), ${rejected} rejected of ${row.proposed ?? 0} proposed, stop ${row.stop_reason ?? '-'}, ${(row.changed_share * 100).toFixed(0)}% changed, $${row.cost_usd.toFixed(3)})`)
        if (outcome === 'rewrite' && first === 'rewrite') console.log(`      still: ${row.left_reasons.join(' | ').slice(0, 400)}`)
      } catch (err) {
        console.warn(`  … ${item.id}: error ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  rows.sort((a, b) => a.id.localeCompare(b.id))
  const count = (o: Row['outcome']) => rows.filter((r) => r.outcome === o).length
  const failing = rows.filter((r) => r.first === 'rewrite').length
  const cost = rows.reduce((n, r) => n + r.cost_usd, 0)
  const summary = {
    drafts: rows.length,
    first_pass: count('pass'),
    failing,
    mended: count('mended'),
    revised: count('revised'),
    still_rewrite: count('rewrite'),
    median_changed_share: [...rows.filter((r) => r.outcome === 'revised').map((r) => r.changed_share)].sort((a, b) => a - b)[Math.floor(count('revised') / 2)] ?? null,
    cost_usd: cost,
  }
  console.log(`\nrevise bench: ${summary.drafts} drafts, ${summary.first_pass} pass the gate as written, ${failing} would be rewritten today.`)
  console.log(`  fixed in place: ${summary.mended} by the mend, ${summary.revised} by the revision; still a full rewrite: ${summary.still_rewrite}/${summary.drafts}`)
  console.log(`  median text changed in a revised draft: ${summary.median_changed_share === null ? '-' : `${(summary.median_changed_share * 100).toFixed(0)}%`}; cost $${cost.toFixed(2)}`)
  const tag = [value('label'), split].filter(Boolean).join('-')
  const path = writeResultFile(
    nextResultPath(`revise-${tag ? `${tag}-` : ''}`, 'json', { dir: join(RESULTS_DIR, '..', 'review-bench') }),
    { kind: 'revise-bench-run', ran_at: new Date().toISOString(), set: setPath, model: model ?? 'writer', summary, rows },
  )
  console.log(`Wrote ${path}`)
}

void main()
