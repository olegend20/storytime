import type { AgeBand, LengthMinutes, StoryOutput } from '@/lib/schemas'

/**
 * Shapes used by the eval harness and the judge (F13/F14).
 *
 * These are deliberately NOT in `lib/schemas/`: that directory is the cross-lane
 * contract and lane 5 does not widen it. Nothing here is written to the database or
 * exchanged with another lane - it is the eval harness's own vocabulary.
 */

/**
 * Anything the judge can score.
 *
 * `StoryOutput` satisfies this structurally, and so does a parsed reference story -
 * which matters, because two of the four references carry 11 headed markdown sections
 * (cold open + 9 journey stops + coda) and therefore do NOT validate against
 * `StoryOutput`, whose `chapters` array caps at 10 (DECISIONS.md #25). Scoring the
 * references through `StoryOutput.parse` would throw on half the calibration set, so
 * the judge takes the looser shape and the gate keeps the strict one.
 */
export interface JudgeableStory {
  title: string
  subtitle: string | null
  chapters: { heading: string; text: string; shout_line?: string | null }[]
  ending_line: string
  true_facts: { text: string; fact_id: string }[]
}

/** A StoryOutput is always judgeable. Compile-time proof, no runtime cost. */
export type StoryOutputIsJudgeable = StoryOutput extends JudgeableStory ? true : never

/** The child block as the judge sees it. No surname, no birthdate - F11/rule 7. */
export interface JudgeChild {
  name: string
  age?: number
  /** Used by the reference manifest where an exact age was not recorded. */
  age_note?: string
  likes?: string[]
  notes?: string | null
}

/** Everything the judge needs about the request, and nothing about who wrote the story. */
export interface JudgeContext {
  children: JudgeChild[]
  age_band: AgeBand
  tones: string[]
  length_minutes: LengthMinutes
  target_words: { min: number; max: number }
  topic_label: string
  /** Series state BEFORE the story. Null for a first story. */
  bible: unknown | null
  /**
   * Blind projection of the fact pack: ids and text only. Sources and confidence are
   * withheld because they are not needed to judge and add tokens to every call.
   */
  fact_pack: { topic_label: string; facts: { id: string; text: string }[] } | null
}

/** Why a cap fired, and - just as importantly - which checks could not be run. */
export interface CapContext {
  guardrailBreach: boolean
  inventedFact: boolean
  wordCountOutOfRange: boolean
  narrativeWordCount: number
  target: { min: number; max: number }
  /**
   * 'checked'  - a fact pack was supplied and every true_facts fact_id was resolved.
   * 'unverifiable_no_fact_pack' - no pack, so `unsourced_fact` was NOT evaluated. The
   *   reference stories predate fact packs and carry synthetic ids (see
   *   lib/reference.ts `asStoryOutput`), so a green here would mean nothing. Never
   *   report an unchecked story as having passed the sourcing check.
   */
  factSourcing: 'checked' | 'unverifiable_no_fact_pack'
  notes: string[]
}
