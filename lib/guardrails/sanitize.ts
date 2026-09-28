/**
 * L1 mechanical input sanitization - GUARDRAILS.md s3.2, first bullet.
 *
 *   "Strip HTML tags, control characters and zero-width characters; collapse whitespace;
 *    enforce max lengths (topic 200, name 30, like 40, notes 300, titles 60)."
 *
 * Scope boundary (F11 vs F15): this module is the *mechanical* half of L1 only. The hard
 * blocklist, the PII patterns and the prompt-injection patterns in the rest of s3.2, and
 * the whole of the L2 classifier, belong to the guardrails lane. They consume this
 * module's output.
 *
 * Ordering matters and is deliberate. `sanitize()` reports what it removed
 * (`removed.html`, `removed.controlChars`, ...) and returns the caller's `original`
 * untouched, so a pattern check for tag-shaped injections (`<system>`, `[INST]`) can run
 * against the original text. A checker that only ever sees the sanitized value can never
 * fire on `<system>`, because this function has already taken it out.
 */

/** s3.2 max lengths, by field. The DB check constraints mirror these. */
export const FIELD_MAX_LENGTH = {
  topic_input: 200,
  first_name: 30,
  like: 40,
  notes: 300,
  /** series.title and families.display_name are both `<= 60` in the schema. */
  title: 60,
  display_name: 60,
} as const

export type SanitizableField = keyof typeof FIELD_MAX_LENGTH

/**
 * Fields where a line break is meaningful content rather than formatting noise.
 * s3.2 treats "more than 3 line breaks in a topic" as an injection signal, so newlines
 * must survive sanitization for that check to have anything to match on.
 */
const MULTILINE_FIELDS: ReadonlySet<SanitizableField> = new Set(['topic_input', 'notes'])

/** Elements whose *contents* are code, not text: drop the whole element. */
const CODE_ELEMENT_RE =
  /<(script|style|iframe|object|embed|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
/** An unclosed `<script ...>` still has to go, along with everything after it. */
const UNCLOSED_CODE_ELEMENT_RE =
  /<(script|style|iframe|object|embed|noscript|template)\b[^>]*>[\s\S]*$/gi
/** Any remaining tag, closing tag, comment, CDATA or processing instruction. */
const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[!?/]?[a-zA-Z][^>]*>|<\/[^>]*>/g

/** C0/C1 control characters, keeping \t \n \r for the whitespace pass to handle. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

/**
 * Zero-width and invisible formatting characters: soft hyphen, Mongolian vowel separator,
 * ZWSP/ZWNJ/ZWJ, the LTR/RTL marks, bidi embedding/override/isolate controls, word
 * joiner, the invisible maths operators, the interlinear annotation controls and the BOM.
 * All of these hide text from a human reviewer while the model still reads it.
 */
const ZERO_WIDTH_RE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g

/** Whitespace that is not a plain space, tab or newline (NBSP, ideographic space, ...). */
const EXOTIC_SPACE_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g

/** Minimal entity decoding, so `&lt;script&gt;` cannot smuggle a tag past TAG_RE. */
const ENTITIES: Readonly<Record<string, string>> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
}
const ENTITY_RE = /&(?:lt|gt|amp|quot|apos|nbsp|#39|#x27);/gi

export interface SanitizeReport {
  /** An HTML tag, comment or code element was removed. */
  html: boolean
  controlChars: boolean
  zeroWidth: boolean
  whitespaceCollapsed: boolean
  /** The value was longer than the field's maximum, whether or not it was cut. */
  overLength: boolean
  /** The value was actually cut to the maximum. False when `cap: false` was passed. */
  truncated: boolean
}

export interface SanitizeOptions {
  /**
   * Cut the value to the field maximum (the default, and what GUARDRAILS.md s3.2 asks
   * for). Pass `false` at a parent-facing API boundary, where an over-long value should
   * come back as a message the parent can act on instead of being silently shortened -
   * see the note on `sanitizeChildPayload`.
   */
  cap?: boolean
}

export interface SanitizeResult {
  /** The cleaned value. Safe to store and to place inside a prompt data block. */
  value: string
  /** Exactly what the caller passed, untouched. */
  original: string
  /** True when `value` differs from `original.trim()`. */
  changed: boolean
  removed: SanitizeReport
}

const EMPTY_REPORT: SanitizeReport = {
  html: false,
  controlChars: false,
  zeroWidth: false,
  whitespaceCollapsed: false,
  overLength: false,
  truncated: false,
}

export function emptyReport(): SanitizeReport {
  return { ...EMPTY_REPORT }
}

/** Code-point length, matching Postgres `char_length()` rather than UTF-16 units. */
export function charLength(value: string): number {
  return Array.from(value).length
}

/** Truncate to `max` code points without splitting a surrogate pair. */
export function truncateChars(value: string, max: number): string {
  const chars = Array.from(value)
  if (chars.length <= max) return value
  return chars.slice(0, max).join('')
}

function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (m) => ENTITIES[m.toLowerCase()] ?? m)
}

function stripHtml(input: string): { value: string; removed: boolean } {
  let out = input
  // Decode twice: `&amp;lt;script&amp;gt;` survives a single pass.
  for (let i = 0; i < 2; i += 1) {
    const decoded = decodeEntities(out)
    if (decoded === out) break
    out = decoded
  }
  let previous: string
  do {
    previous = out
    out = out.replace(CODE_ELEMENT_RE, ' ')
    out = out.replace(UNCLOSED_CODE_ELEMENT_RE, ' ')
    out = out.replace(TAG_RE, ' ')
  } while (out !== previous)
  return { value: out, removed: out !== input }
}

/**
 * Sanitize one free-text field.
 *
 * @param field   the s3.2 field, which fixes the max length and whether newlines survive
 * @param raw     whatever arrived from the client; a non-string sanitizes to `''`
 * @param options `cap: false` to report an over-long value instead of cutting it
 */
export function sanitize(
  field: SanitizableField,
  raw: unknown,
  options: SanitizeOptions = {},
): SanitizeResult {
  const original = typeof raw === 'string' ? raw : ''
  if (original === '') {
    return { value: '', original, changed: false, removed: emptyReport() }
  }

  const removed = emptyReport()
  let out = original.normalize('NFC')

  const html = stripHtml(out)
  removed.html = html.removed
  out = html.value

  const beforeControl = out
  out = out.replace(CONTROL_RE, '')
  removed.controlChars = out !== beforeControl

  const beforeZeroWidth = out
  out = out.replace(ZERO_WIDTH_RE, '')
  removed.zeroWidth = out !== beforeZeroWidth

  out = out.replace(EXOTIC_SPACE_RE, ' ')

  const beforeWhitespace = out
  if (MULTILINE_FIELDS.has(field)) {
    // Keep line breaks (the injection check counts them); collapse everything else.
    out = out
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  } else {
    out = out.replace(/\s+/g, ' ')
  }
  out = out.trim()
  removed.whitespaceCollapsed = out !== beforeWhitespace.trim()

  const max = FIELD_MAX_LENGTH[field]
  if (charLength(out) > max) {
    removed.overLength = true
    if (options.cap !== false) {
      out = truncateChars(out, max).trim()
      removed.truncated = true
    }
  }

  return { value: out, original, changed: out !== original.trim(), removed }
}

/** Convenience wrapper when only the cleaned string is wanted. */
export function sanitizeField(
  field: SanitizableField,
  raw: unknown,
  options: SanitizeOptions = {},
): string {
  return sanitize(field, raw, options).value
}

/** Sanitize a `likes[]` array: clean each tag, drop blanks, de-duplicate, keep order. */
export function sanitizeLikes(raw: unknown): { value: string[]; removed: SanitizeReport } {
  const list = Array.isArray(raw) ? raw : []
  const removed = emptyReport()
  const seen = new Set<string>()
  const value: string[] = []
  for (const item of list) {
    const r = sanitize('like', item)
    removed.html ||= r.removed.html
    removed.controlChars ||= r.removed.controlChars
    removed.zeroWidth ||= r.removed.zeroWidth
    removed.whitespaceCollapsed ||= r.removed.whitespaceCollapsed
    removed.overLength ||= r.removed.overLength
    removed.truncated ||= r.removed.truncated
    if (r.value === '') continue
    const key = r.value.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    value.push(r.value)
  }
  return { value, removed }
}

/** True when any report had HTML removed - the F11 AC rejection signal. */
export function containedHtml(...reports: readonly SanitizeReport[]): boolean {
  return reports.some((r) => r.html)
}
