import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cutViolations, passagesFor } from '@/lib/generate/mend'
import { scanStoryText } from '@/lib/guardrails/output'
import { StoryOutput, storyText, type OutputViolation } from '@/lib/schemas'

/**
 * The mend bench (issue #66): how often the delivery ladder can place a hard violation the
 * gate found, measured on every one the safety review and the scanner actually raised in the
 * captured eval runs. Free and deterministic - no model call - so the ladder's placement is
 * hill-climbed here, then confirmed by the 32-story eval.
 *
 * A violation the ladder cannot place can be neither mended nor cut, so it ends in a discard:
 * on 2026-10-17 both of the eval's discards were quotes the ladder could not place.
 */

export interface MendBenchCase {
  id: string
  source: 'safety_review' | 'scanner'
  story: unknown
  violations: OutputViolation[]
}

export interface MendBenchSet {
  version: number
  built: string
  cases: MendBenchCase[]
}

export interface MendBenchResult {
  cases: number
  violations: number
  /** Hard violations the ladder placed (a chapter sentence, or a true fact). */
  located: number
  /** Cases where every hard violation was placed. */
  fullyPlaced: number
  /** Cases the cut (rung 2) would complete: every violation placed and removed. */
  cutComplete: number
  /** Scanner cases whose cut story the scanner then finds clean. */
  scannerCleared: number
  scannerCases: number
  /** Characters of story the completed cuts removed: lower keeps more of the book. */
  charsCut: number
  unlocated: { id: string; rule: number; quote: string }[]
}

export const MEND_BENCH_SET = join(process.cwd(), 'eval', 'mend-bench', 'set-2026-10-18.json')

export function loadMendBench(path: string = MEND_BENCH_SET): MendBenchSet {
  return JSON.parse(readFileSync(path, 'utf8')) as MendBenchSet
}

/** The scanner's hard hits, rule 7 left out: it was retired, and the gate drops it. */
function scannerHits(story: StoryOutput): OutputViolation[] {
  return scanStoryText(storyText(story)).hardViolations.filter((v) => v.rule !== 7)
}

export function scoreMendBench(set: MendBenchSet): MendBenchResult {
  const result: MendBenchResult = {
    cases: 0,
    violations: 0,
    located: 0,
    fullyPlaced: 0,
    cutComplete: 0,
    scannerCleared: 0,
    scannerCases: 0,
    charsCut: 0,
    unlocated: [],
  }
  for (const c of set.cases) {
    // As captured: the ladder reads only the chapters and the true facts, and a few drafts
    // fail the schema on fields the pipeline tidies before the gate (a long bible rule).
    const parsed = StoryOutput.safeParse(c.story)
    const story = parsed.success ? parsed.data : (c.story as StoryOutput)
    // The scanner is code under test: its cases are scanned again now, not read from the
    // set. The safety review's quotes are what it said on the day, frozen.
    const violations = c.source === 'scanner' ? scannerHits(story) : c.violations
    result.cases += 1
    result.violations += violations.length
    const { unlocated } = passagesFor(story, violations)
    result.located += violations.length - unlocated.length
    if (unlocated.length === 0) result.fullyPlaced += 1
    for (const v of unlocated) result.unlocated.push({ id: c.id, rule: v.rule, quote: v.quote })
    const cut = cutViolations(story, violations)
    if (cut.complete) {
      result.cutComplete += 1
      result.charsCut += storyText(story).length - storyText(cut.story).length
    }
    if (c.source === 'scanner') {
      result.scannerCases += 1
      if (cut.complete && scannerHits(cut.story).length === 0) result.scannerCleared += 1
    }
  }
  return result
}
