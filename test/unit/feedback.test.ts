import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { handleFeedback } from '@/lib/feedback/handlers'
import { MAX_NAME, MAX_TEXT, QUESTIONS } from '@/lib/feedback/questions'
import { parseFeedback } from '@/lib/feedback/validate'

/**
 * Tester feedback (owner request 2026-11-20): the rules on what a submission may hold, and
 * the route body against a fake client. The real table and its RLS are test/int/feedback.test.ts.
 */

/** A client whose `from('feedback').insert(row)` records the row. */
function fakeDb(fail = false) {
  const rows: unknown[] = []
  const db = {
    from: (table: string) => ({
      insert: async (row: unknown) => {
        if (table !== 'feedback') throw new Error(`unexpected table ${table}`)
        if (fail) return { error: { message: 'boom' } }
        rows.push(row)
        return { error: null }
      },
    }),
  } as unknown as SupabaseClient
  return { db, rows }
}

describe('parseFeedback (VT-FB1)', () => {
  it('accepts one answer and leaves the rest empty', () => {
    const parsed = parseFeedback({ enjoyment: 'loved' })
    expect(parsed).toEqual({
      ok: true,
      row: {
        enjoyment: 'loved',
        stories_read: null,
        loved: null,
        confusing: null,
        reading_on: null,
        wish: null,
        keep_using: null,
        anything_else: null,
        name: null,
        email: null,
      },
    })
  })

  it('accepts a full submission, trimming text and lowercasing the email', () => {
    const parsed = parseFeedback({
      enjoyment: 'liked',
      stories_read: 'few',
      loved: '  The dinosaur facts ',
      confusing: 'The loading wait',
      reading_on: ['phone', 'ereader', 'phone'],
      wish: 'Bigger text',
      keep_using: 'most_nights',
      anything_else: 'Thanks!',
      name: ' Sam ',
      email: ' Sam@Example.com ',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.row.loved).toBe('The dinosaur facts')
    expect(parsed.row.reading_on).toEqual(['phone', 'ereader'])
    expect(parsed.row.name).toBe('Sam')
    expect(parsed.row.email).toBe('sam@example.com')
  })

  it('needs at least one answer; a name and email alone are not feedback', () => {
    expect(parseFeedback({})).toEqual({ ok: false, field: 'form', reason: 'empty' })
    expect(parseFeedback({ loved: '   ', reading_on: [] })).toEqual({ ok: false, field: 'form', reason: 'empty' })
    expect(parseFeedback({ name: 'Sam', email: 'sam@example.com' })).toEqual({ ok: false, field: 'form', reason: 'empty' })
    expect(parseFeedback(null)).toEqual({ ok: false, field: 'form', reason: 'empty' })
  })

  it('refuses a choice that is not on the list', () => {
    expect(parseFeedback({ enjoyment: 'amazing' })).toMatchObject({ ok: false, field: 'enjoyment', reason: 'invalid' })
    expect(parseFeedback({ reading_on: ['phone', 'fax'] })).toMatchObject({ ok: false, field: 'reading_on', reason: 'invalid' })
    expect(parseFeedback({ reading_on: 'phone' })).toMatchObject({ ok: false, field: 'reading_on', reason: 'invalid' })
    // A pick-one answer of the wrong type is refused too, not silently dropped.
    expect(parseFeedback({ enjoyment: 5, loved: 'ok' })).toMatchObject({ ok: false, field: 'enjoyment', reason: 'invalid' })
    expect(parseFeedback({ keep_using: ['sometimes'] })).toMatchObject({ ok: false, field: 'keep_using', reason: 'invalid' })
  })

  it('refuses over-long text and names', () => {
    expect(parseFeedback({ loved: 'a'.repeat(MAX_TEXT + 1) })).toMatchObject({ ok: false, field: 'loved', reason: 'too_long' })
    expect(parseFeedback({ loved: 'a'.repeat(MAX_TEXT) }).ok).toBe(true)
    expect(parseFeedback({ loved: 'ok', name: 'n'.repeat(MAX_NAME + 1) })).toMatchObject({ ok: false, field: 'name', reason: 'too_long' })
  })

  it('refuses an email that is not one, but an empty email is fine', () => {
    expect(parseFeedback({ loved: 'ok', email: 'not-an-email' })).toMatchObject({ ok: false, field: 'email', reason: 'bad_email' })
    expect(parseFeedback({ loved: 'ok', email: '  ' }).ok).toBe(true)
  })

  it('asks nothing about a child: no question key names a child field (rule 7)', () => {
    const keys = QUESTIONS.map((q) => q.key as string)
    for (const forbidden of ['child', 'child_name', 'age', 'birthdate', 'surname', 'photo', 'school', 'location']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})

describe('handleFeedback (VT-FB2)', () => {
  it('stores a valid submission and answers ok', async () => {
    const { db, rows } = fakeDb()
    const res = await handleFeedback({ service: db }, { keep_using: 'sometimes', loved: 'Space story' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ keep_using: 'sometimes', loved: 'Space story' })
  })

  it('answers 400 with the field and stores nothing for a bad submission', async () => {
    const { db, rows } = fakeDb()
    const res = await handleFeedback({ service: db }, { enjoyment: 'nope' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid_request', field: 'enjoyment' })
    expect(rows).toHaveLength(0)
  })

  it('answers a bot (honeypot filled) as normal and stores nothing', async () => {
    const { db, rows } = fakeDb()
    const res = await handleFeedback({ service: db }, { loved: 'buy pills', website: 'http://spam.example' })
    expect(res.status).toBe(200)
    expect(rows).toHaveLength(0)
  })

  it('answers 500 when the database refuses, without echoing the input', async () => {
    const { db } = fakeDb(true)
    const res = await handleFeedback({ service: db }, { loved: 'secret words' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('server_error')
    expect(JSON.stringify(body)).not.toContain('secret words')
  })
})
