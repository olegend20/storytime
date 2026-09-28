import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CorpusEntry, OutputCorpusEntry } from '@/lib/schemas'
import { checkField } from '@/lib/guardrails/l1'
import { scanStoryText } from '@/lib/guardrails/output'
import type { GuardedField } from '@/lib/guardrails/sanitize'

/**
 * Shared corpus loading and measurement, used by the guardrail suite and by
 * `pnpm guardrails:report`. Keeping the arithmetic in one place means the numbers in a
 * report and the numbers the tests assert on cannot drift apart.
 */

export const CORPUS_DIR = join(process.cwd(), 'test', 'guardrails')

export function loadInputCorpus(name: string): CorpusEntry[] {
  const raw = JSON.parse(readFileSync(join(CORPUS_DIR, name), 'utf8')) as unknown[]
  return raw.map((e, i) => {
    const parsed = CorpusEntry.safeParse(e)
    if (!parsed.success) {
      throw new Error(`${name}[${i}] invalid: ${JSON.stringify(parsed.error.issues)}`)
    }
    return parsed.data
  })
}

export function loadOutputCorpus(name = 'outputs_violations.json'): OutputCorpusEntry[] {
  const raw = JSON.parse(readFileSync(join(CORPUS_DIR, name), 'utf8')) as unknown[]
  return raw.map((e, i) => {
    const parsed = OutputCorpusEntry.safeParse(e)
    if (!parsed.success) {
      throw new Error(`${name}[${i}] invalid: ${JSON.stringify(parsed.error.issues)}`)
    }
    return parsed.data
  })
}

export interface L1Outcome {
  entry: CorpusEntry
  refused: boolean
  category: string | null
  internalReason: string | null
}

/** L1 only - free, no model call, deterministic. */
export function runL1(entry: CorpusEntry): L1Outcome {
  const result = checkField({ field: entry.field as GuardedField, value: entry.input })
  return {
    entry,
    refused: !result.ok,
    category: result.category,
    internalReason: result.internal_reason,
  }
}

export interface L1Report {
  total: number
  refused: number
  /** Entries L1 refused that should have been allowed. */
  falseRefusals: L1Outcome[]
  /** Entries L1 refused, of those marked `layer: 'L1'`. */
  l1Marked: number
  l1MarkedCaught: number
  l1MarkedMissed: L1Outcome[]
  /** Category agreement among the entries L1 refused. */
  categoryAgreement: number
  categoryMismatches: L1Outcome[]
}

export function measureL1(entries: CorpusEntry[]): L1Report {
  const outcomes = entries.map(runL1)
  const shouldRefuse = (e: CorpusEntry): boolean => e.expected === 'refuse'

  const falseRefusals = outcomes.filter((o) => o.refused && !shouldRefuse(o.entry))
  const marked = outcomes.filter((o) => o.entry.layer === 'L1')
  const markedCaught = marked.filter((o) => o.refused)
  const refusedCorrectly = outcomes.filter((o) => o.refused && shouldRefuse(o.entry))
  const categoryMismatches = refusedCorrectly.filter(
    (o) => o.category !== o.entry.expected_category,
  )

  return {
    total: entries.length,
    refused: outcomes.filter((o) => o.refused).length,
    falseRefusals,
    l1Marked: marked.length,
    l1MarkedCaught: markedCaught.length,
    l1MarkedMissed: marked.filter((o) => !o.refused),
    categoryAgreement:
      refusedCorrectly.length === 0
        ? 1
        : (refusedCorrectly.length - categoryMismatches.length) / refusedCorrectly.length,
    categoryMismatches,
  }
}

export interface OutputOutcome {
  entry: OutputCorpusEntry
  hardRules: number[]
  softRules: number[]
  caught: boolean
  /** Hard rules fired that the entry did not claim - reported as a precision signal. */
  extraRules: number[]
}

export function runOutput(entry: OutputCorpusEntry): OutputOutcome {
  const scan = scanStoryText(entry.excerpt)
  const hardRules = [...new Set(scan.violations.filter((v) => v.severity === 'hard').map((v) => v.rule))]
  const softRules = [...new Set(scan.violations.filter((v) => v.severity === 'soft').map((v) => v.rule))]
  const expected = entry.expected_rule
  return {
    entry,
    hardRules,
    softRules,
    caught: expected === null ? hardRules.length === 0 : hardRules.includes(expected),
    extraRules: expected === null ? hardRules : hardRules.filter((r) => r !== expected),
  }
}

export interface OutputReport {
  breaching: number
  breachingCaught: number
  missed: OutputOutcome[]
  clean: number
  cleanFalsePositives: OutputOutcome[]
  /** Breaching excerpts that also fired an unrelated hard rule. */
  overFiring: OutputOutcome[]
  perRule: Record<number, { total: number; caught: number }>
}

export function measureOutput(entries: OutputCorpusEntry[]): OutputReport {
  const outcomes = entries.map(runOutput)
  const breaching = outcomes.filter((o) => o.entry.expected_rule !== null)
  const clean = outcomes.filter((o) => o.entry.expected_rule === null)

  const perRule: Record<number, { total: number; caught: number }> = {}
  for (const o of breaching) {
    const rule = o.entry.expected_rule as number
    const row = perRule[rule] ?? { total: 0, caught: 0 }
    row.total += 1
    if (o.caught) row.caught += 1
    perRule[rule] = row
  }

  return {
    breaching: breaching.length,
    breachingCaught: breaching.filter((o) => o.caught).length,
    missed: breaching.filter((o) => !o.caught),
    clean: clean.length,
    cleanFalsePositives: clean.filter((o) => !o.caught),
    overFiring: breaching.filter((o) => o.extraRules.length > 0),
    perRule,
  }
}

export function pct(n: number, d: number): string {
  if (d === 0) return 'n/a'
  return `${((n / d) * 100).toFixed(1)}%`
}

/**
 * The nightly workflow uploads `test/guardrails/results/` as an artifact, so every corpus
 * run leaves its measured numbers there. Ignored by version control - run artefacts, not
 * source.
 */
export function writeResults(name: string, payload: Record<string, unknown>): string {
  const dir = join(CORPUS_DIR, 'results')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.json`)
  const body = {
    recorded_at: new Date().toISOString(),
    live: process.env.LIVE_API === '1',
    ...payload,
  }
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return path
}
