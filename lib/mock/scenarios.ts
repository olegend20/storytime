import type { ErrorBody, SseEvent } from '@/lib/schemas'

/**
 * Mock-only failure triggers, so every error state in F10 has an e2e test.
 *
 * A parent never types a leading `!`, and `checkTopic()` does not strip it, so these sentinels
 * cannot collide with a real topic. They exist ONLY in the mock backend - lane 2's real route
 * knows nothing about them.
 *
 * The `message` strings are the examples written out in `GUARDRAILS.md` §5. They are
 * PLACEHOLDERS for `config/guardrails/messages.json`, which lane 6 owns: at runtime the copy
 * arrives in the `error` event and the UI renders it verbatim. Lane 4 does not compose refusal
 * copy, and none of these strings are referenced by the UI.
 */

export type MockScenario =
  | 'ok'
  | 'topic_refused'
  | 'too_mature_for_band'
  | 'quota_exceeded'
  | 'service_paused'
  | 'budget_exceeded'
  | 'midstream_failure'
  | 'unknown_event'
  | 'slow'

const SENTINELS: ReadonlyArray<[string, MockScenario]> = [
  ['!refuse', 'topic_refused'],
  ['!mature', 'too_mature_for_band'],
  ['!quota', 'quota_exceeded'],
  ['!paused', 'service_paused'],
  ['!budget', 'budget_exceeded'],
  ['!midfail', 'midstream_failure'],
  ['!unknownevent', 'unknown_event'],
  ['!slow', 'slow'],
]

export function scenarioFor(topicInput: string): MockScenario {
  const lower = topicInput.toLowerCase()
  for (const [sentinel, scenario] of SENTINELS) {
    if (lower.includes(sentinel)) return scenario
  }
  return 'ok'
}

/** Placeholder parent-facing copy. See the note above: lane 6 owns the real file. */
const MESSAGES: Record<string, string> = {
  topic_refused:
    "We can't make a story about that. Pick something fun to learn about and we'll get started.",
  too_mature_for_band:
    "That one's a bit much for a 4-year-old. How about how giant ships float? Or pick just your older child for tonight.",
  quota_exceeded:
    "That's all three stories for today. Your next one unlocks at midnight — sleep well!",
  service_paused: 'StoryTime is taking a short break tonight. Please try again tomorrow.',
  budget_exceeded: 'StoryTime is taking a short break tonight. Please try again tomorrow.',
  generation_failed: "We couldn't make a story we're happy with tonight. Try a different angle.",
}

export const PRE_STREAM_SCENARIOS: Partial<Record<MockScenario, ErrorBody['code']>> = {
  topic_refused: 'topic_refused',
  too_mature_for_band: 'too_mature_for_band',
  quota_exceeded: 'quota_exceeded',
  service_paused: 'service_paused',
  budget_exceeded: 'budget_exceeded',
}

export function mockErrorBody(code: string, resets_at: string | null = null): ErrorBody {
  return {
    code,
    message: MESSAGES[code] ?? 'Something went wrong. Please try again.',
    // A refusal costs no quota and no writing-model call (GUARDRAILS.md §7 / F15 AC).
    quota_consumed: false,
    resets_at,
  }
}

/** A mid-stream failure: HTTP 200 already sent, so the failure is an `error` event. */
export function midstreamErrorEvent(): Extract<SseEvent, { type: 'error' }> {
  return {
    type: 'error',
    code: 'generation_failed',
    message: MESSAGES.generation_failed ?? '',
    quota_consumed: false,
    resets_at: null,
  }
}
