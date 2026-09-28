/**
 * L1 sanitization - GUARDRAILS.md s3.2, first bullet.
 * "Strip HTML tags, control characters and zero-width characters; collapse whitespace;
 *  enforce max lengths (topic 200, name 30, like 40, notes 300, titles 60)."
 *
 * Free, deterministic, and runs before anything else (s1.2 cheap layers first).
 */

/** The fields a parent can type into (s3.1). Tone and length are enums. */
export const GUARDED_FIELDS = [
  'topic_input',
  'first_name',
  'likes',
  'notes',
  'title',
  'display_name',
] as const
export type GuardedField = (typeof GUARDED_FIELDS)[number]

/** s3.2 max lengths. `title` covers series titles; `display_name` is the family name. */
export const FIELD_MAX_LENGTH: Record<GuardedField, number> = {
  topic_input: 200,
  first_name: 30,
  likes: 40,
  notes: 300,
  title: 60,
  display_name: 60,
}

/** s3.2: "Reject topic inputs that are only punctuation/emoji or under 2 characters." */
export const TOPIC_MIN_LENGTH = 2

/** s3.2: "or more than 3 line breaks in a topic". */
export const MAX_TOPIC_LINE_BREAKS = 3

// Zero-width, soft hyphen, BOM, word joiner - the classic invisible-payload characters.
const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD\u180E]/g
// Bidi controls: can visually reorder a blocklisted word so it reads innocently.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g
// C0/C1 controls except \n, \r and \t (whitespace collapse handles those).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
// Tag-like spans, including unclosed ones at the end of the string.
const HTML_TAG = /<\/?[a-zA-Z][^<>]*>?/g
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g
// Entity-encoded markup, so "&lt;script&gt;" cannot smuggle a tag past the tag stripper.
const HTML_ENTITY_TAG = /&(?:lt|#60|#x3c);\s*\/?\s*[a-zA-Z][^&]{0,200}?&(?:gt|#62|#x3e);/gi

export interface SanitizeResult {
  /** Cleaned, whitespace-collapsed, length-capped text. */
  text: string
  /** Cleaned text before the length cap, so the caller can tell "too long" from "trimmed". */
  full: string
  /** What the sanitizer had to remove. Any true value is itself a signal (s3.2). */
  removed: {
    html: boolean
    control: boolean
    zeroWidth: boolean
    bidi: boolean
  }
  /** Line breaks counted BEFORE whitespace collapse (the s3.2 topic rule needs them). */
  lineBreaks: number
  /** True when `full` was longer than the field's cap. */
  truncated: boolean
}

/**
 * Normalization only - no rejection decisions. `checkField()` in l1.ts turns the
 * metadata below into an L1Result.
 */
export function sanitizeText(raw: string, field: GuardedField = 'topic_input'): SanitizeResult {
  const limit = FIELD_MAX_LENGTH[field]
  // NFKC folds fullwidth/compatibility look-alikes onto their ASCII forms, so
  // "ｂｏｍｂ" cannot walk past an ASCII blocklist.
  let text = raw.normalize('NFKC')

  const beforeZeroWidth = text
  text = text.replace(ZERO_WIDTH, '')
  const zeroWidth = text !== beforeZeroWidth

  const beforeBidi = text
  text = text.replace(BIDI, '')
  const bidi = text !== beforeBidi

  const beforeHtml = text
  text = text.replace(HTML_COMMENT, ' ').replace(HTML_ENTITY_TAG, ' ').replace(HTML_TAG, ' ')
  const html = text !== beforeHtml

  const beforeControl = text
  text = text.replace(CONTROL, ' ')
  const control = text !== beforeControl

  const lineBreaks = (text.match(/\r\n|\r|\n/g) ?? []).length

  const full = text.replace(/\s+/g, ' ').trim()
  const truncated = full.length > limit

  return {
    text: truncated ? full.slice(0, limit).trim() : full,
    full,
    removed: { html, control, zeroWidth, bidi },
    lineBreaks,
    truncated,
  }
}

/** s3.2: a topic of only punctuation or emoji carries no topic at all. */
export function hasNoLetterOrDigit(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}

/**
 * Story text for the L4 deterministic scan. Output text is model-generated, so the
 * obfuscation-resistant input path is not needed here - only invisible characters,
 * which would break the word-boundary matcher.
 */
export function sanitizeStoryText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(BIDI, '')
    .replace(CONTROL, ' ')
    .replace(/[ \t]+/g, ' ')
}
