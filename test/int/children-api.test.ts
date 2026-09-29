import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_CHILDREN_PER_FAMILY } from '@/lib/schemas'
import { ensureFamily } from '@/lib/family/service'
import { listChildren } from '@/lib/children/service'
import {
  handleCreateChild,
  handleDeleteChild,
  handleListChildren,
  handleUpdateChild,
  type ChildRequestContext,
} from '@/lib/children/handlers'
import {
  cleanupUser,
  createTestUser,
  localDbAvailable,
  serviceClient,
  SKIP_REASON,
  type TestUser,
} from './support/lane1-db'

/**
 * F3 integration VT: "creating a 9th child returns 400 with a friendly message."
 * Plus the F11 AC "API rejects payloads with HTML/script content in text fields", and the
 * F3 AC that deleting a child does not break an existing series.
 *
 * These drive `lib/children/handlers.ts` - the real endpoint bodies, with real Response
 * objects and real status codes - against a real RLS-scoped client. Only the cookie
 * plumbing is left out, and that is covered by the Playwright suite.
 */

const dbUp = await localDbAvailable()
if (!dbUp) console.warn(`[F3 int] skipped: ${SKIP_REASON}`)

interface Body {
  code?: string
  message?: string
  field?: string | null
  child?: { id: string; first_name: string; age: number; likes: string[]; notes: string | null }
  children?: { id: string; first_name: string }[]
  affected_series?: number
}

async function body(response: Response): Promise<Body> {
  return (await response.json()) as Body
}

describe.runIf(dbUp)('F3 children endpoint', () => {
  let user: TestUser | null = null
  let ctx: ChildRequestContext

  beforeAll(async () => {
    user = await createTestUser('children-api')
    const family = await ensureFamily(user.client, user.userId)
    ctx = { db: user.client, familyId: family.id }
  })

  afterAll(async () => cleanupUser(user))

  it('creates a child and returns 201', async () => {
    const response = await handleCreateChild(ctx, {
      first_name: 'Cruz',
      age: 7,
      likes: ['football', 'LEGO'],
      notes: 'Loves goalkeeping',
      reading_level: 'older',
    })
    expect(response.status).toBe(201)
    const created = (await body(response)).child!
    expect(created.first_name).toBe('Cruz')
    expect(created.likes).toEqual(['football', 'LEGO'])
  })

  it('sanitizes on the way in - the stored name has no stray whitespace', async () => {
    const response = await handleCreateChild(ctx, { first_name: '  Phoenix  ', age: 4 })
    expect(response.status).toBe(201)
    expect((await body(response)).child!.first_name).toBe('Phoenix')
  })

  it('lists the family children', async () => {
    const listed = (await body(await handleListChildren(ctx))).children!
    expect(listed.map((c) => c.first_name)).toEqual(['Cruz', 'Phoenix'])
  })

  it.each([
    [{ first_name: 'Cruz', age: 0 }, 'age 0'],
    [{ first_name: 'Cruz', age: 18 }, 'age 18'],
    [{ first_name: 'a'.repeat(31), age: 7 }, 'a 31-character name'],
    [{ first_name: 'Cruz9', age: 7 }, 'digits in a name'],
    [{ first_name: '', age: 7 }, 'an empty name'],
    [
      { first_name: 'Cruz', age: 7, likes: Array.from({ length: 11 }, (_, i) => `l${i}`) },
      '11 likes',
    ],
    [{ first_name: 'Cruz', age: 7, notes: 'x'.repeat(301) }, 'a 301-character note'],
  ])('rejects %j (%s) with 400 and a message the parent can act on', async (payload, _why) => {
    const response = await handleCreateChild(ctx, payload)
    expect(response.status).toBe(400)
    const result = await body(response)
    expect(result.code).toBe('invalid_request')
    expect(result.message).toBeTruthy()
    // Parent-facing copy: a sentence, not a schema dump.
    expect(result.message).not.toMatch(/zod|expected|invalid_type|undefined/i)
  })

  it('names the field to fix on a length rejection', async () => {
    const tooLongName = await body(await handleCreateChild(ctx, { first_name: 'a'.repeat(31), age: 7 }))
    expect(tooLongName.field).toBe('first_name')
    expect(tooLongName.message).toBe('First names can be up to 30 characters.')

    const tooLongNote = await body(
      await handleCreateChild(ctx, { first_name: 'Lennon', age: 10, notes: 'y'.repeat(400) }),
    )
    expect(tooLongNote.field).toBe('notes')
    expect(tooLongNote.message).toBe('Notes can be up to 300 characters.')
  })

  it('rejects HTML in a text field with 400 html_not_allowed (F11 AC)', async () => {
    for (const payload of [
      { first_name: '<script>alert(1)</script>Cruz', age: 7 },
      { first_name: 'Cruz', age: 7, notes: 'Loves <b>football</b>' },
      { first_name: 'Cruz', age: 7, likes: ['<iframe src=x></iframe>'] },
    ]) {
      const response = await handleCreateChild(ctx, payload)
      expect(response.status).toBe(400)
      const result = await body(response)
      expect(result.code).toBe('html_not_allowed')
      expect(result.field).toBeTruthy()
    }
  })

  it('ignores a field that is not in the closed list - no last_name is ever stored', async () => {
    const response = await handleCreateChild(ctx, {
      first_name: 'Ada',
      age: 6,
      last_name: 'Lovelace',
      birthdate: '2020-01-01',
    })
    expect(response.status).toBe(201)
    const created = (await body(response)).child!
    expect(Object.keys(created).sort()).toEqual([
      'age',
      'created_at',
      'family_id',
      'first_name',
      'id',
      'likes',
      'notes',
      'reading_level',
      'updated_at',
    ])
    await handleDeleteChild(ctx, created.id)
  })

  it('updates one field without blanking the others', async () => {
    const listed = (await body(await handleListChildren(ctx))).children!
    const cruz = listed.find((c) => c.first_name === 'Cruz')!
    const response = await handleUpdateChild(ctx, cruz.id, { age: 8 })
    expect(response.status).toBe(200)
    const updated = (await body(response)).child!
    expect(updated.age).toBe(8)
    expect(updated.likes).toEqual(['football', 'LEGO'])
    expect(updated.notes).toBe('Loves goalkeeping')
  })

  it('rejects an empty patch', async () => {
    const listed = (await body(await handleListChildren(ctx))).children!
    const response = await handleUpdateChild(ctx, listed[0]!.id, {})
    expect(response.status).toBe(400)
  })

  it('404s an unknown child id', async () => {
    const response = await handleUpdateChild(
      ctx,
      '11111111-2222-4333-8444-555555555555',
      { age: 9 },
    )
    expect(response.status).toBe(404)
  })

  it('404s a malformed child id rather than 500ing', async () => {
    expect((await handleUpdateChild(ctx, 'not-a-uuid', { age: 9 })).status).toBe(404)
    expect((await handleDeleteChild(ctx, 'not-a-uuid')).status).toBe(404)
  })

  it('404s a child that belongs to another family', async () => {
    const other = await createTestUser('children-other')
    try {
      const otherFamily = await ensureFamily(other.client, other.userId)
      const created = await other.client
        .from('children')
        .insert({ family_id: otherFamily.id, first_name: 'Theirs', age: 9 })
        .select('id')
        .single()
      expect(created.error).toBeNull()

      expect((await handleUpdateChild(ctx, created.data!.id, { age: 10 })).status).toBe(404)
      expect((await handleDeleteChild(ctx, created.data!.id)).status).toBe(404)

      // ...and it is still there, untouched.
      const still = await other.client.from('children').select('age').eq('id', created.data!.id)
      expect(still.data?.[0]?.age).toBe(9)
    } finally {
      await cleanupUser(other)
    }
  })
})

describe.runIf(dbUp)('F3 the 8-child ceiling', () => {
  let user: TestUser | null = null
  let ctx: ChildRequestContext

  beforeAll(async () => {
    user = await createTestUser('child-limit')
    const family = await ensureFamily(user.client, user.userId)
    ctx = { db: user.client, familyId: family.id }
  })

  afterAll(async () => cleanupUser(user))

  it('accepts eight children', async () => {
    for (let i = 1; i <= MAX_CHILDREN_PER_FAMILY; i += 1) {
      const response = await handleCreateChild(ctx, { first_name: `Kid${'a'.repeat(i)}`, age: 7 })
      expect(response.status, `child ${i}`).toBe(201)
    }
    expect(await listChildren(ctx.db, ctx.familyId)).toHaveLength(MAX_CHILDREN_PER_FAMILY)
  })

  it('returns 400 with a friendly message for the 9th (F3 VT)', async () => {
    const response = await handleCreateChild(ctx, { first_name: 'Ninth', age: 7 })
    expect(response.status).toBe(400)
    const result = await body(response)
    expect(result.code).toBe('child_limit_reached')
    expect(result.message).toBe('You can add up to 8 children. Remove one before adding another.')
    expect(result.field).toBe('children')
  })

  it('does not write the 9th row', async () => {
    expect(await listChildren(ctx.db, ctx.familyId)).toHaveLength(MAX_CHILDREN_PER_FAMILY)
  })

  it('accepts a new child again once one is removed', async () => {
    const existing = await listChildren(ctx.db, ctx.familyId)
    expect((await handleDeleteChild(ctx, existing[0]!.id)).status).toBe(200)
    expect((await handleCreateChild(ctx, { first_name: 'Replacement', age: 7 })).status).toBe(201)
  })
})

describe.runIf(dbUp)('F3 deleting a child does not break an existing series', () => {
  let user: TestUser | null = null
  let ctx: ChildRequestContext
  let seriesId = ''
  let storyId = ''
  let removedChildId = ''
  let keptChildId = ''

  beforeAll(async () => {
    user = await createTestUser('series-intact')
    const family = await ensureFamily(user.client, user.userId)
    ctx = { db: user.client, familyId: family.id }

    const cruz = (await body(await handleCreateChild(ctx, { first_name: 'Cruz', age: 7 }))).child!
    const phoenix = (await body(await handleCreateChild(ctx, { first_name: 'Phoenix', age: 4 })))
      .child!
    keptChildId = cruz.id
    removedChildId = phoenix.id

    const series = await serviceClient()
      .from('series')
      .insert({
        family_id: family.id,
        child_ids: [cruz.id, phoenix.id].sort(),
        child_key: `lane1-intact-${Date.now()}`,
        title: 'Cruz and Phoenix',
      })
      .select('id')
      .single()
    expect(series.error).toBeNull()
    seriesId = series.data!.id

    await serviceClient().from('story_bibles').insert({
      series_id: seriesId,
      family_id: family.id,
      content: { children: [] },
      token_estimate: 100,
    })
    const story = await serviceClient()
      .from('stories')
      .insert({
        family_id: family.id,
        series_id: seriesId,
        topic_input: 'sharks',
        topic_key: 'sharks',
        tones: ['exciting'],
        length_minutes: 10,
        age_band: 'A',
        title: 'The Shark Submarine',
        content: { chapters: [] },
        word_count: 1859,
      })
      .select('id')
      .single()
    expect(story.error).toBeNull()
    storyId = story.data!.id
  })

  afterAll(async () => cleanupUser(user))

  it('tells the caller how many series still list the child', async () => {
    const response = await handleDeleteChild(ctx, removedChildId)
    expect(response.status).toBe(200)
    expect((await body(response)).affected_series).toBe(1)
  })

  it('leaves the series row exactly as it was, stale id included', async () => {
    const { data, error } = await user!.client
      .from('series')
      .select('child_ids,title')
      .eq('id', seriesId)
      .single()
    expect(error).toBeNull()
    expect(data!.child_ids).toContain(removedChildId)
    expect(data!.child_ids).toContain(keptChildId)
    expect(data!.title).toBe('Cruz and Phoenix')
  })

  it('leaves the story and its bible readable (F3 AC)', async () => {
    const story = await user!.client.from('stories').select('title').eq('id', storyId).single()
    expect(story.error).toBeNull()
    expect(story.data!.title).toBe('The Shark Submarine')

    const bible = await user!.client
      .from('story_bibles')
      .select('token_estimate')
      .eq('series_id', seriesId)
      .single()
    expect(bible.error).toBeNull()
  })

  it('the remaining child is untouched', async () => {
    const remaining = await listChildren(ctx.db, ctx.familyId)
    expect(remaining.map((c) => c.id)).toEqual([keptChildId])
  })
})

/**
 * F11 VT: "`children` has no `last_name`/`birthdate` column (schema assertion)."
 *
 * test/int/schema.test.ts already asserts this, but only behind `RUN_SCHEMA_TESTS=1`
 * (`pnpm test:schema`, which CI runs in the `migrations` job). This copy runs whenever a
 * local database is up, so the guarantee is checked by a plain `pnpm test` too.
 */
describe.runIf(dbUp)('F11 children column list is closed', () => {
  const admin = serviceClient()

  it.each(['last_name', 'birthdate', 'surname', 'date_of_birth', 'photo_url', 'address', 'school'])(
    'children.%s does not exist',
    async (column) => {
      const { error } = await admin.from('children').select(column).limit(0)
      expect(error, `children.${column} must not exist`).not.toBeNull()
    },
  )

  it('children has exactly the five permitted data columns plus keys and timestamps', async () => {
    const { error } = await admin
      .from('children')
      .select('id,family_id,first_name,age,likes,notes,reading_level,created_at,updated_at')
      .limit(0)
    expect(error).toBeNull()
  })
})
