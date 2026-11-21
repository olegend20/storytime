import { normalizeEmail } from '@/lib/waitlist/email'
import { MAX_NAME, MAX_TEXT, QUESTIONS, type ChoiceQuestion } from './questions'

/**
 * Turn a POST /api/feedback body into the row to store, or say which field is wrong.
 * Pure, so the unit tests cover every rule without a database.
 */

export interface FeedbackRow {
  enjoyment: string | null
  stories_read: string | null
  loved: string | null
  confusing: string | null
  reading_on: string[] | null
  wish: string | null
  keep_using: string | null
  anything_else: string | null
  name: string | null
  email: string | null
}

export type FeedbackParse =
  | { ok: true; row: FeedbackRow }
  | { ok: false; field: string; reason: 'invalid' | 'too_long' | 'empty' | 'bad_email' }

/** Trimmed text, or null when empty. Anything that is not a string is "not answered". */
function text(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value === '' ? null : value
}

function allowed(q: ChoiceQuestion): Set<string> {
  return new Set(q.choices.map((c) => c.value))
}

export function parseFeedback(body: unknown): FeedbackParse {
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const row: FeedbackRow = {
    enjoyment: null,
    stories_read: null,
    loved: null,
    confusing: null,
    reading_on: null,
    wish: null,
    keep_using: null,
    anything_else: null,
    name: null,
    email: null,
  }

  for (const q of QUESTIONS) {
    const raw = input[q.key]
    if (q.kind === 'text') {
      const value = text(raw)
      if (value && value.length > MAX_TEXT) return { ok: false, field: q.key, reason: 'too_long' }
      row[q.key] = value
    } else if (q.kind === 'one') {
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        return { ok: false, field: q.key, reason: 'invalid' }
      }
      const value = text(raw)
      if (value === null) continue
      if (!allowed(q).has(value)) return { ok: false, field: q.key, reason: 'invalid' }
      row[q.key as 'enjoyment' | 'stories_read' | 'keep_using'] = value
    } else {
      if (raw === undefined || raw === null) continue
      if (!Array.isArray(raw)) return { ok: false, field: q.key, reason: 'invalid' }
      const ok = allowed(q)
      const picked = [...new Set(raw)]
      if (!picked.every((v) => typeof v === 'string' && ok.has(v))) {
        return { ok: false, field: q.key, reason: 'invalid' }
      }
      row.reading_on = picked.length > 0 ? (picked as string[]) : null
    }
  }

  const answered = QUESTIONS.some((q) => row[q.key] !== null)
  if (!answered) return { ok: false, field: 'form', reason: 'empty' }

  const name = text(input.name)
  if (name && name.length > MAX_NAME) return { ok: false, field: 'name', reason: 'too_long' }
  row.name = name

  const rawEmail = text(input.email)
  if (rawEmail !== null) {
    const email = normalizeEmail(rawEmail)
    if (!email) return { ok: false, field: 'email', reason: 'bad_email' }
    row.email = email
  }

  return { ok: true, row }
}
