import { describe, expect, it } from 'vitest'
import { ChildInput, MAX_CHILDREN_PER_FAMILY } from '@/lib/schemas'
import { ChildPatch, sanitizeChildPayload } from '@/lib/children/service'

/**
 * F3: the server half of "validation on client and server".
 *
 * `test/unit/schemas.test.ts` already covers `ChildInput` itself (the F3 unit VT). This
 * file covers what the API route adds on top of it: sanitization before validation, the
 * partial-update schema, and the HTML rejection the F11 AC asks for.
 */

describe('F3 child payload sanitization', () => {
  it('cleans a first name and reports nothing suspicious', () => {
    const { input, htmlField } = sanitizeChildPayload({ first_name: '  Cruz  ', age: 7 })
    expect(input.first_name).toBe('Cruz')
    expect(htmlField).toBeNull()
  })

  it('reports the field that contained HTML (F11 AC: reject those payloads)', () => {
    expect(sanitizeChildPayload({ first_name: '<b>Cruz</b>' }).htmlField).toBe('first_name')
    expect(sanitizeChildPayload({ notes: '<script>x()</script>hi' }).htmlField).toBe('notes')
    expect(sanitizeChildPayload({ likes: ['<i>lego</i>'] }).htmlField).toBe('likes')
  })

  it('names only the first offending field, so the parent gets one thing to fix', () => {
    const { htmlField } = sanitizeChildPayload({ first_name: '<b>C</b>', notes: '<i>n</i>' })
    expect(htmlField).toBe('first_name')
  })

  it('coerces an age posted as a string, so the schema message is the one shown', () => {
    expect(sanitizeChildPayload({ age: '7' }).input.age).toBe(7)
    const parsed = ChildInput.safeParse(sanitizeChildPayload({ first_name: 'Cruz', age: '7' }).input)
    expect(parsed.success).toBe(true)
  })

  it('leaves a non-numeric age alone for the schema to reject', () => {
    const { input } = sanitizeChildPayload({ first_name: 'Cruz', age: 'seven' })
    expect(ChildInput.safeParse(input).success).toBe(false)
  })

  it('turns an empty note into null rather than an empty string', () => {
    expect(sanitizeChildPayload({ notes: '   ' }).input.notes).toBeNull()
    expect(sanitizeChildPayload({ notes: null }).input.notes).toBeNull()
  })

  it('turns an empty reading level into null', () => {
    expect(sanitizeChildPayload({ reading_level: '' }).input.reading_level).toBeNull()
  })

  it('returns only the keys the client sent, so PATCH cannot silently blank a field', () => {
    expect(Object.keys(sanitizeChildPayload({ age: 8 }).input)).toEqual(['age'])
  })

  it('de-duplicates likes case-insensitively', () => {
    expect(sanitizeChildPayload({ likes: ['LEGO', 'lego', 'Lego'] }).input.likes).toEqual(['LEGO'])
  })

  it('does NOT cut an over-long name or note, so the server can validate the length', () => {
    // GUARDRAILS.md s3.2 caps lengths by default, but at a parent-facing endpoint a name
    // silently shortened to 30 characters could never fail the F3 AC's length rule - and
    // a truncated child's name is a worse outcome than a message saying the limit.
    const name = sanitizeChildPayload({ first_name: 'a'.repeat(31), age: 7 })
    expect((name.input.first_name as string).length).toBe(31)
    const parsedName = ChildInput.safeParse(name.input)
    expect(parsedName.success).toBe(false)
    expect(parsedName.error?.issues[0]?.message).toBe('First names can be up to 30 characters.')

    const note = sanitizeChildPayload({ first_name: 'Cruz', age: 7, notes: 'x'.repeat(400) })
    expect((note.input.notes as string).length).toBe(400)
    const parsedNote = ChildInput.safeParse(note.input)
    expect(parsedNote.success).toBe(false)
    expect(parsedNote.error?.issues[0]?.message).toBe('Notes can be up to 300 characters.')
  })

  it('still caps each like at 40 characters, where trimming costs nothing', () => {
    const { input } = sanitizeChildPayload({ likes: ['a'.repeat(60)] })
    expect((input.likes as string[])[0]!.length).toBe(40)
  })

  it('still rejects an 11th like - truncation is for length, not for count', () => {
    const { input } = sanitizeChildPayload({
      first_name: 'Cruz',
      age: 7,
      likes: Array.from({ length: 11 }, (_, i) => `like-${i}`),
    })
    const parsed = ChildInput.safeParse(input)
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toBe('Up to 10 likes per child.')
  })
})

describe('F3 child patch schema', () => {
  it('accepts a single field', () => {
    expect(ChildPatch.safeParse({ age: 8 }).success).toBe(true)
    expect(ChildPatch.safeParse({ first_name: 'Phoenix' }).success).toBe(true)
    expect(ChildPatch.safeParse({ notes: null }).success).toBe(true)
    expect(ChildPatch.safeParse({ reading_level: 'older' }).success).toBe(true)
  })

  it('rejects an empty patch', () => {
    expect(ChildPatch.safeParse({}).success).toBe(false)
  })

  it('applies the same rules as ChildInput', () => {
    expect(ChildPatch.safeParse({ age: 0 }).success).toBe(false)
    expect(ChildPatch.safeParse({ age: 18 }).success).toBe(false)
    expect(ChildPatch.safeParse({ first_name: 'a'.repeat(31) }).success).toBe(false)
    expect(ChildPatch.safeParse({ first_name: 'Cruz9' }).success).toBe(false)
    expect(ChildPatch.safeParse({ notes: 'x'.repeat(301) }).success).toBe(false)
    expect(
      ChildPatch.safeParse({ likes: Array.from({ length: 11 }, (_, i) => `l${i}`) }).success,
    ).toBe(false)
  })

  it('does not invent defaults for fields the parent did not send', () => {
    const parsed = ChildPatch.parse({ age: 8 })
    expect(Object.keys(parsed)).toEqual(['age'])
  })
})

describe('F3 limit constant', () => {
  it('is 8 children per family', () => {
    expect(MAX_CHILDREN_PER_FAMILY).toBe(8)
  })
})
