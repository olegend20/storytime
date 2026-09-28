import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { FIXTURE_ROOT, MissingFixtureError, writeFixture } from '@/lib/ai'
import type { JudgeScoreWithExcerpts } from '@/lib/eval/judge'

/**
 * Drives the judge through the REAL `callModel()` path in replay mode, fabricating the
 * fixture a call is missing instead of reaching the network.
 *
 * Why not inject a fake transport? Because kickoff rule 1 says every model call goes
 * through `callModel()`, and a test that bypasses it stops testing the thing that ships.
 * `callModel()` in replay mode throws `MissingFixtureError` carrying the exact fixture key
 * it wanted, so the loop is: run → catch the miss → write that fixture → run again. The
 * harness is deterministic, so the second run replays the fixture and proceeds to the next
 * missing call.
 *
 * `test/setup.ts` points FIXTURE_DIR at a temp directory, so nothing written here can be
 * mistaken for a fixture recorded from a real response (kickoff rule 3).
 */

export interface FixtureMissInfo {
  purpose: string
  model: string
  key: string
  /** 0-based index of this miss within the run, for scripting a sequence of responses. */
  index: number
}

export type JudgeResponder = (info: FixtureMissInfo) => string

const DEFAULT_USAGE = {
  input_tokens: 5_000,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 900,
}

/**
 * Fabricated judge fixtures are keyed by payload hash, so two tests that score the same
 * story with the same context would share one fixture and the second test would silently
 * replay the first test's script. Clearing the judge fixtures before each scripted run
 * keeps the tests independent. Only the temp FIXTURE_DIR is touched, never a recorded one.
 */
function resetJudgeFixtures(): void {
  for (const purpose of ['judge_score', 'judge_pairwise']) {
    rmSync(join(FIXTURE_ROOT, purpose), { recursive: true, force: true })
  }
}

export async function withScriptedJudge<T>(
  run: () => Promise<T>,
  respond: JudgeResponder,
  opts: { maxMisses?: number; reset?: boolean } = {},
): Promise<T> {
  const maxMisses = opts.maxMisses ?? 400
  if (opts.reset !== false) resetJudgeFixtures()
  const written = new Set<string>()
  let index = 0

  for (let attempt = 0; attempt <= maxMisses; attempt += 1) {
    try {
      return await run()
    } catch (err) {
      if (!(err instanceof MissingFixtureError)) throw err
      if (written.has(err.key)) {
        throw new Error(
          `Fabricated a fixture for key ${err.key} but callModel asked for it again. ` +
            `Either FIXTURE_DIR is not writable or the payload is not deterministic.`,
        )
      }
      const text = respond({ purpose: err.purpose, model: err.model, key: err.key, index })
      index += 1
      written.add(err.key)
      writeFixture(err.purpose, err.key, {
        purpose: err.purpose,
        model: err.model,
        response: { content: [{ type: 'text', text }] },
        usage: DEFAULT_USAGE,
        stop_reason: 'end_turn',
        recorded_at: new Date().toISOString(),
      })
    }
  }
  throw new Error(`Exceeded ${maxMisses} fixture misses; the run is probably not converging.`)
}

/** A well-formed SCORE response, for scripting. */
export function scoreResponse(
  scores: JudgeScoreWithExcerpts['scores'],
  extra: Partial<JudgeScoreWithExcerpts> = {},
): string {
  const body: JudgeScoreWithExcerpts = {
    scores,
    evidence: {
      center: 'evidence center',
      craft: 'evidence craft',
      facts: 'evidence facts',
      age_fit: 'evidence age fit',
      continuity: 'evidence continuity',
      delight: 'evidence delight',
    },
    caps_applied: ['none'],
    disqualified: false,
    // Deliberately wrong: the harness must recompute this and discard the model's number.
    overall: 1.11,
    editor_notes: ['note one', 'note two', 'note three'],
    best_moment: 'The brick went click, and it held.',
    worst_moment: 'It was a very interesting thing to look at.',
    ...extra,
  }
  return JSON.stringify(body)
}

export function pairwiseResponse(
  verdict: 'A' | 'B' | 'TIE',
  confidence = 0.8,
  perCriterion: 'A' | 'B' | 'TIE' = verdict,
): string {
  return JSON.stringify({
    per_criterion: {
      center: perCriterion,
      craft: perCriterion,
      facts: 'TIE',
      age_fit: perCriterion,
      continuity: 'TIE',
      delight: perCriterion,
    },
    verdict,
    confidence,
    justification: 'One story does more with the same facts.',
  })
}
