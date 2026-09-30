import { wordCountWithinTolerance, type CheckFailure, type OutputViolation } from '@/lib/schemas'
import type { CapContext, JudgeableStory } from './types'
import { narrativeWordCount } from './render'

/**
 * The §3 automatic caps, decided in OUR code.
 *
 * DECISIONS.md #12: "a cap that the model can forget to apply is not a cap." The judge
 * *detects* (it reads the prose and the fact pack and says what it sees); the harness
 * *decides* (it turns a detection into a score ceiling). `applyCaps` in
 * `lib/schemas/judge.ts` does the arithmetic; this module builds the boolean context it
 * takes, and records which checks could not be run at all.
 */

/** What F7's gate tells us, once lane 2 lands it. All fields optional by design. */
export interface GateSummary {
  outcome?: 'pass' | 'rewrite' | 'flagged' | 'discarded'
  hard_violations?: OutputViolation[]
  failures?: CheckFailure[]
  /**
   * From F7's Haiku review (`QualityReview.scary_level`, 0-3). F13 AC checks the titanic
   * scenario passes with scary_level <= 1 for band B, which is a gate output, not a judge
   * output - the judge scores age fit, it does not emit a scary level.
   */
  scary_level?: number | null
}

/** The minimum a fact pack must expose for the sourcing check. */
export interface FactPackLike {
  facts: { id: string }[]
}

/** A cap the judge reported, in its own words. Matched loosely - it is free-form text. */
function judgeReported(capsApplied: readonly string[], pattern: RegExp): boolean {
  return capsApplied.some((c) => pattern.test(c))
}

export interface CapContextInput {
  story: JudgeableStory
  target: { min: number; max: number }
  /** Null when no pack was recorded - the reference stories predate fact packs. */
  factPack: FactPackLike | null
  /** Null until F6/F7 land, or when scoring a story that never went through the gate. */
  gate: GateSummary | null
  /** What the judge said. Only its *detections* are used, never its arithmetic. */
  judge: { disqualified: boolean; caps_applied: readonly string[] }
}

export function buildCapContext(input: CapContextInput): CapContext {
  const notes: string[] = []
  const words = narrativeWordCount(input.story)
  const wordCountOutOfRange = !wordCountWithinTolerance(words, input.target)
  if (wordCountOutOfRange) {
    notes.push(
      `narrative word count ${words} is outside ${input.target.min}-${input.target.max} ±15%`,
    )
  }

  // --- Guardrail breach: the gate is authoritative; the judge is a second pair of eyes.
  const gateHard = input.gate?.hard_violations ?? []
  const gateSaysBreach = gateHard.length > 0 || input.gate?.outcome === 'discarded'
  const judgeSaysBreach =
    input.judge.disqualified || judgeReported(input.judge.caps_applied, /guardrail|rule_?\d/i)
  const guardrailBreach = gateSaysBreach || judgeSaysBreach
  if (gateSaysBreach) notes.push(`gate reported ${gateHard.length} hard violation(s)`)
  if (judgeSaysBreach && !gateSaysBreach) notes.push('judge reported a guardrail breach')
  if (input.gate === null) {
    notes.push('no F7 gate result available: guardrail breach rests on the judge alone')
  }

  // --- Invented fact. Two independent signals, and an honest "not checked".
  let factSourcing: CapContext['factSourcing'] = 'unverifiable_no_fact_pack'
  let unsourced: string[] = []
  if (input.factPack) {
    factSourcing = 'checked'
    const known = new Set(input.factPack.facts.map((f) => f.id))
    unsourced = input.story.true_facts.filter((f) => !known.has(f.fact_id)).map((f) => f.fact_id)
    if (unsourced.length > 0) {
      notes.push(`unsourced_fact: ${unsourced.join(', ')} not in the fact pack`)
    }
  } else {
    // lib/reference.ts asStoryOutput() hands out SYNTHETIC fact ids because the reference
    // stories predate fact packs. Running the id check against them would "pass" every
    // time while testing nothing, so it is recorded as unverifiable instead - the eval
    // and calibration JSON both carry this field so a green is never misread.
    notes.push(
      'unsourced_fact NOT evaluated: no fact pack, so true_facts fact_ids are unverifiable ' +
        '(synthetic for the reference stories). Only the judge\'s own reading of the facts counts.',
    )
  }
  const inventedFact =
    unsourced.length > 0 || judgeReported(input.judge.caps_applied, /invent|contradict/i)
  if (inventedFact && unsourced.length === 0) notes.push('judge reported an invented fact')

  return {
    guardrailBreach,
    inventedFact,
    wordCountOutOfRange,
    narrativeWordCount: words,
    target: input.target,
    factSourcing,
    notes,
  }
}
