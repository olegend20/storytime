#!/usr/bin/env tsx
import { existsSync } from 'node:fs'
import { MeteredLogSink } from '@/lib/ai'
import { installCliCostLogging } from '@/lib/costs/cli'
import {
  clearJudgeErrors,
  formatFamilyReport,
  loadFamilyEvalRows,
  rubricDifferences,
  runFamilyEval,
  summarizeBaseline,
  summarizeFamilyRows,
} from '@/lib/eval/family'
import type { EvalResult } from '@/lib/eval/harness'
import { readResultFile } from '@/lib/eval/results'
import { supabaseService } from '@/lib/supabase/service'

/**
 * `pnpm eval:family` - issue #132. Scores the books the owner's family made during the writer
 * trial (the `story_evals` rows with no score) with the eval's judge, and prints them beside a
 * Sonnet eval. LIVE: each book is one judge call, about $0.10-0.15 on the primary judge.
 *
 * It reads whichever database SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY name. The trial's books
 * are in production, so point those at production to score them.
 *
 * Flags:
 *   --report-only     score nothing; print the report from the scores already saved
 *   --dry-run         say how many books are waiting and what scoring them is estimated to cost
 *   --limit=N         score at most N books this run
 *   --retry-errors    try again the books an earlier run could not score
 *   --baseline=PATH   the eval file to compare with (default: the Sonnet eval of 2026-11-04)
 *   --budget=N        approve up to $N for this run (default ceiling $20, as pnpm eval)
 */

/** Sonnet 5, master v6, the in-place fix: production's writer, 32 stories, mean 4.12. */
const DEFAULT_BASELINE = 'eval/results/eval-2026-11-04.json'
/** Per book, for the estimate: above the $0.10 the judge averaged on 2026-11-06..11. */
const JUDGE_USD_PER_BOOK = 0.15
const DEFAULT_BUDGET_CEILING_USD = 20

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}
function value(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit?.slice(name.length + 3)
}

async function main(): Promise<void> {
  const baselinePath = value('baseline') ?? DEFAULT_BASELINE
  if (!existsSync(baselinePath)) {
    console.error(`--baseline=${baselinePath}: no such file.`)
    process.exitCode = 1
    return
  }
  const baseline = readResultFile<EvalResult>(baselinePath)
  const db = supabaseService()

  const reportOnly = flag('report-only')
  const limitRaw = value('limit')
  const limit = limitRaw === undefined ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    console.error(`--limit=${limitRaw}: a whole number of books, 1 or more.`)
    process.exitCode = 1
    return
  }

  if (!reportOnly) {
    if (flag('retry-errors') && !flag('dry-run')) {
      console.log(`${await clearJudgeErrors(db)} book(s) an earlier run could not score will be tried again.`)
    }
    const waiting = await loadFamilyEvalRows(db, { unjudgedOnly: true, ...(limit !== undefined ? { limit } : {}) })
    const estimate = waiting.length * JUDGE_USD_PER_BOOK
    console.log(`${waiting.length} book(s) waiting for a score; estimated $${estimate.toFixed(2)} at $${JUDGE_USD_PER_BOOK.toFixed(2)} a book.`)
    if (flag('dry-run')) {
      console.log('--dry-run: no calls made.')
      return
    }
    const approved = Number(value('budget') ?? '0')
    const ceiling = approved > 0 ? approved : DEFAULT_BUDGET_CEILING_USD
    if (estimate > ceiling) {
      console.error(`Refusing to start: the estimate is $${estimate.toFixed(2)} and the approved ceiling is $${ceiling.toFixed(2)}. Use --limit or --budget.`)
      process.exitCode = 1
      return
    }
    if (waiting.length > 0) {
      const live = process.env.LIVE_API === '1' || process.env.LIVE_API === 'true'
      if (!live) {
        console.error('Scoring calls the judge. Run with LIVE_API=1 (or --report-only to print saved scores).')
        process.exitCode = 1
        return
      }
      const costLogging = installCliCostLogging()
      if (!costLogging.persisting) console.warn(`[costs] ${costLogging.reason}`)
      const run = await runFamilyEval({
        db,
        sink: new MeteredLogSink(),
        ...(limit !== undefined ? { limit } : {}),
        onProgress: (line) => console.log(`  … ${line}`),
      })
      console.log(
        `Scored ${run.scored} book(s) for $${run.costUsd.toFixed(2)}; ${run.errors} cannot be scored (reason on the row); ` +
          `${run.failed} failed this run and will be tried again.`,
      )
      if (run.failed > 0) process.exitCode = 1
    }
    console.log('')
  }

  const rows = await loadFamilyEvalRows(db)
  if (rows.length === 0) {
    console.log('No trial books recorded yet. A book is recorded when the owner saves a story while OWNER_WRITING_MODEL is set.')
    return
  }
  const writers = [...new Set(rows.map((r) => `${r.writer_model} + ${r.master_prompt}`))].join(', ')
  console.log(
    formatFamilyReport({
      rows,
      trial: summarizeFamilyRows(rows, writers),
      baseline: summarizeBaseline(baseline, baselinePath),
      differences: rubricDifferences(rows, baseline),
    }),
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
