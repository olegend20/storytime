/**
 * Client-side mirror of the deterministic input rules in `GUARDRAILS.md` §3.2 (F11 UI part).
 *
 * This is a courtesy, not a control. The server sanitizer and the L2 classifier (lane 1 /
 * lane 6) are authoritative; anything that gets past this still gets refused there. Its only
 * job is to catch a typo-shaped mistake before the parent waits on a request.
 *
 * Deliberately NOT mirrored here: the hard blocklist and the L2 classifier. Shipping the
 * blocklist to the browser would publish it, and a client-side safety verdict would be a
 * safety control an attacker can edit. Shape rules only.
 *
 * Messages never echo what the parent typed and never name the rule that fired
 * (`GUARDRAILS.md` §5).
 */

export const TOPIC_MAX_LENGTH = 200
export const TOPIC_MIN_LENGTH = 2

const HTML_TAG = /<\/?[a-z][^>]*>/gi
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const ZERO_WIDTH = /[\u00ad\u200b-\u200f\u2060\ufeff]/g

/**
 * Strip tags, control characters and zero-width characters; collapse runs of whitespace.
 * Newlines survive as spaces so the line-break rule below counts them before collapsing.
 */
export function sanitizeTopic(raw: string): string {
  return raw
    .replace(HTML_TAG, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(ZERO_WIDTH, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TOPIC_MAX_LENGTH)
}

/** Patterns a parent typing a bedtime topic never needs. `GUARDRAILS.md` §3.2. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /system\s+prompt/i,
  /you\s+are\s+now\b/i,
  /developer\s+mode/i,
  /<\s*\/?\s*(system|assistant|user|human)\s*>/i,
  /\[\s*\/?\s*INST\s*\]/i,
  /```/,
  /###/,
  /^\s*(system|assistant)\s*:/i,
]

/** PII shapes. `GUARDRAILS.md` §3.2 - a topic is not the place for contact details. */
const PII_PATTERNS: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
  /\bhttps?:\/\//i,
  /\bwww\.[a-z0-9-]+\.[a-z]{2,}/i,
  /(?:\+?\d[\d\s().-]{8,}\d)/,
  /\b\d{16}\b/,
  /\b\d{1,5}\s+[A-Z][a-z]+\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|close|way)\b/i,
]

/** A topic that is only punctuation, digits or emoji carries no subject. */
const HAS_LETTER = /\p{L}/u

export type TopicIssue =
  | 'too_short'
  | 'no_subject'
  | 'too_long'
  | 'looks_like_instructions'
  | 'contains_contact_details'

export interface TopicCheck {
  ok: boolean
  /** The sanitized value to send. Always present so the caller can submit it. */
  value: string
  issue: TopicIssue | null
  /** Parent-facing, kind, and free of the parent's own text. */
  message: string | null
}

const MESSAGES: Record<TopicIssue, string> = {
  too_short: 'Add a few more words so we know what the story is about.',
  no_subject: 'Tell us a subject in words — "sharks", or "how volcanoes work".',
  too_long: `Keep the topic under ${TOPIC_MAX_LENGTH} characters. A few words works best.`,
  looks_like_instructions:
    'Try describing the topic in plain words — something like "the history of bicycles".',
  contains_contact_details:
    'Please leave out links, addresses and phone numbers. Just the topic is perfect.',
}

export function checkTopic(raw: string): TopicCheck {
  const hadLineBreaks = (raw.match(/\n/g) ?? []).length > 3
  const value = sanitizeTopic(raw)

  const fail = (issue: TopicIssue): TopicCheck => ({
    ok: false,
    value,
    issue,
    message: MESSAGES[issue],
  })

  if (raw.trim().length > TOPIC_MAX_LENGTH) return fail('too_long')
  if (value.length < TOPIC_MIN_LENGTH) return fail('too_short')
  if (!HAS_LETTER.test(value)) return fail('no_subject')
  if (hadLineBreaks || INJECTION_PATTERNS.some((p) => p.test(raw))) {
    return fail('looks_like_instructions')
  }
  if (PII_PATTERNS.some((p) => p.test(value))) return fail('contains_contact_details')

  return { ok: true, value, issue: null, message: null }
}
