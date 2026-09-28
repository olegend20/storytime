import messagesJson from '@/config/guardrails/messages.json'

/**
 * Parent-facing copy (GUARDRAILS.md §5). Never built in code: a refusal message that a
 * developer improvises inline is a message nobody reviewed, and §5 has rules about these
 * (short, kind, no echo of the input, no hint of which layer fired).
 */

/**
 * Keyed by the `code` on ErrorBody / the SSE error event (lib/schemas/api.ts).
 * `error_codes` is the merged section: lane 6 owns the parent-facing copy in this file and
 * lane 2 needed the SSE codes, so they were folded into one object rather than two lanes
 * keeping separate wordings for the same situation.
 */
const data = messagesJson as unknown as { error_codes: Record<string, string> }

export type ParentMessageKey =
  | 'off_mission'
  | 'too_mature_for_band'
  | 'topic_refused'
  | 'generation_failed'
  | 'quota_exceeded'
  | 'service_paused'
  | 'budget_exceeded'
  | 'invalid_request'

export function parentMessage(key: ParentMessageKey): string {
  const message = data.error_codes[key]
  if (!message) {
    throw new Error(`No parent-facing message for "${key}" in config/guardrails/messages.json`)
  }
  return message
}
