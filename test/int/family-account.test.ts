import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteAccount, ensureFamily, getFamily, updateFamily } from '@/lib/family/service'
import { handleUpdateFamily } from '@/lib/family/handlers'
import {
  cleanupUser,
  createTestUser,
  localDbAvailable,
  serviceClient,
  SKIP_REASON,
  type TestUser,
} from './support/lane1-db'

/**
 * F2 integration VTs, against the live local Supabase:
 *
 *  - "logging in twice creates exactly one `families` row"
 *  - "RLS - user A cannot select user B's children/stories/series/bibles via the anon
 *     client (expect 0 rows, not an error)"
 *  - "delete account -> counts of children/series/stories/bibles for that family are 0;
 *     `generation_logs.family_id` is null for those rows"
 *
 * The RLS migrations were verified end-to-end by the lead (16/16 in
 * scripts/dev/probe-rls.ts). These assert the same isolation through this lane's own code
 * paths, which is what the VT asks for.
 */

const dbUp = await localDbAvailable()
if (!dbUp) console.warn(`[F2 int] skipped: ${SKIP_REASON}`)

/** A marker no other lane will use, so the log rows this test makes are findable. */
const LOG_MODEL_MARKER = `lane1-f2-${Date.now()}`

describe.runIf(dbUp)('F2 one family per user', () => {
  let user: TestUser | null = null
  afterAll(async () => cleanupUser(user))

  it('the first login creates exactly one families row', async () => {
    user = await createTestUser('one-family')
    const family = await ensureFamily(user.client, user.userId)
    expect(family.owner_user_id).toBe(user.userId)
    expect(family.timezone).toBe('UTC')

    const { data, error } = await user.client.from('families').select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('re-login never creates a second family (F2 AC)', async () => {
    // Four more sessions' worth of ensureFamily, including two concurrent ones.
    const again = await ensureFamily(user!.client, user!.userId)
    const [a, b] = await Promise.all([
      ensureFamily(user!.client, user!.userId),
      ensureFamily(user!.client, user!.userId),
    ])
    expect(again.id).toBe(a.id)
    expect(b.id).toBe(a.id)

    const { data } = await serviceClient()
      .from('families')
      .select('id')
      .eq('owner_user_id', user!.userId)
    expect(data).toHaveLength(1)
  })

  it('records the timezone detected at login when one is supplied', async () => {
    const fresh = await createTestUser('tz-at-login')
    try {
      const family = await ensureFamily(fresh.client, fresh.userId, {
        timezone: 'Europe/London',
      })
      expect(family.timezone).toBe('Europe/London')
    } finally {
      await cleanupUser(fresh)
    }
  })

  it('falls back to UTC rather than storing an unusable timezone', async () => {
    const fresh = await createTestUser('tz-bogus')
    try {
      const family = await ensureFamily(fresh.client, fresh.userId, { timezone: 'EST' })
      expect(family.timezone).toBe('UTC')
    } finally {
      await cleanupUser(fresh)
    }
  })

  it('saves display name and timezone, and rejects a bogus zone at the endpoint', async () => {
    const family = await updateFamily(user!.client, (await getFamily(user!.client, user!.userId))!.id, {
      display_name: 'The Test Family',
      timezone: 'Europe/London',
    })
    expect(family.display_name).toBe('The Test Family')
    expect(family.timezone).toBe('Europe/London')

    const rejected = await handleUpdateFamily(
      { db: user!.client, family },
      { timezone: '+05:00' },
    )
    expect(rejected.status).toBe(400)
    const body = (await rejected.json()) as { code: string; field: string }
    expect(body.code).toBe('invalid_request')
    expect(body.field).toBe('timezone')

    // ...and the stored value is untouched.
    expect((await getFamily(user!.client, user!.userId))!.timezone).toBe('Europe/London')
  })

  it('a client cannot claim a family owned by someone else', async () => {
    const other = await createTestUser('spoof-target')
    try {
      const spoof = await user!.client
        .from('families')
        .insert({ owner_user_id: other.userId, display_name: 'Stolen' })
        .select()
      expect(spoof.error).not.toBeNull()
    } finally {
      await cleanupUser(other)
    }
  })
})

describe.runIf(dbUp)('F2 RLS isolation between families', () => {
  let a: TestUser | null = null
  let b: TestUser | null = null
  let bFamilyId = ''

  beforeAll(async () => {
    a = await createTestUser('rls-a')
    b = await createTestUser('rls-b')
    await ensureFamily(a.client, a.userId)
    const familyB = await ensureFamily(b.client, b.userId)
    bFamilyId = familyB.id

    // B fills every family-scoped table the VT names.
    const child = await b.client
      .from('children')
      .insert({ family_id: bFamilyId, first_name: 'Lennon', age: 10 })
      .select('id')
      .single()
    expect(child.error).toBeNull()

    const series = await b.client
      .from('series')
      .insert({
        family_id: bFamilyId,
        child_ids: [child.data!.id],
        child_key: `lane1-rls-${Date.now()}`,
      })
      .select('id')
      .single()
    expect(series.error).toBeNull()

    const bible = await b.client.from('story_bibles').insert({
      series_id: series.data!.id,
      family_id: bFamilyId,
      content: { children: [] },
      token_estimate: 10,
    })
    expect(bible.error).toBeNull()

    const story = await b.client.from('stories').insert({
      family_id: bFamilyId,
      series_id: series.data!.id,
      topic_input: 'the Titanic',
      topic_key: 'the-titanic',
      tones: ['exciting'],
      length_minutes: 10,
      age_band: 'C',
      title: 'B only',
      content: { chapters: [] },
      word_count: 100,
    })
    expect(story.error).toBeNull()
  })

  afterAll(async () => {
    await cleanupUser(a)
    await cleanupUser(b)
  })

  it.each(['children', 'series', 'story_bibles', 'stories'] as const)(
    'user A sees zero rows of user B %s - and no error',
    async (table) => {
      const asA = await a!.client.from(table).select('*')
      expect(asA.error, `${table}: RLS must hide rows, not raise`).toBeNull()
      expect(asA.data).toEqual([])

      // Sanity check that the rows really are there for their owner.
      const asB = await b!.client.from(table).select('*')
      expect(asB.error).toBeNull()
      expect((asB.data ?? []).length).toBeGreaterThan(0)
    },
  )

  it('user A sees only its own family row', async () => {
    const asA = await a!.client.from('families').select('display_name')
    expect(asA.error).toBeNull()
    expect(asA.data).toHaveLength(1)
  })

  it('user A cannot write into user B family', async () => {
    const write = await a!.client
      .from('children')
      .insert({ family_id: bFamilyId, first_name: 'Intruder', age: 5 })
      .select()
    expect(write.error).not.toBeNull()
  })

  it('a filter naming user B family id still returns nothing', async () => {
    const targeted = await a!.client.from('stories').select('title').eq('family_id', bFamilyId)
    expect(targeted.error).toBeNull()
    expect(targeted.data).toEqual([])
  })
})

describe.runIf(dbUp)('F2 account deletion', () => {
  let user: TestUser | null = null
  let familyId = ''
  const admin = serviceClient()

  beforeAll(async () => {
    user = await createTestUser('delete-account')
    familyId = (await ensureFamily(user.client, user.userId)).id

    const children = await user.client
      .from('children')
      .insert([
        { family_id: familyId, first_name: 'Cruz', age: 7 },
        { family_id: familyId, first_name: 'Phoenix', age: 4 },
      ])
      .select('id')
    expect(children.error).toBeNull()

    const series = await user.client
      .from('series')
      .insert({
        family_id: familyId,
        child_ids: children.data!.map((c) => c.id),
        child_key: `lane1-del-${Date.now()}`,
      })
      .select('id')
      .single()
    expect(series.error).toBeNull()

    await user.client.from('story_bibles').insert({
      series_id: series.data!.id,
      family_id: familyId,
      content: { children: [] },
      token_estimate: 42,
    })
    await user.client.from('stories').insert({
      family_id: familyId,
      series_id: series.data!.id,
      topic_input: 'volcanoes',
      topic_key: 'volcanoes',
      tones: ['exciting'],
      length_minutes: 10,
      age_band: 'B',
      title: 'Doomed story',
      content: { chapters: [] },
      word_count: 1200,
    })

    // daily_usage and generation_logs are service-role writes (F8 territory); the point
    // here is that the cascade reaches the first and anonymizes the second.
    await admin.from('daily_usage').insert({
      family_id: familyId,
      usage_date: new Date().toISOString().slice(0, 10),
      count: 2,
    })
    const logs = await admin.from('generation_logs').insert([
      { family_id: familyId, purpose: 'write', model: LOG_MODEL_MARKER, cost_usd: 0.0123 },
      { family_id: familyId, purpose: 'quality', model: LOG_MODEL_MARKER, cost_usd: 0.0004 },
    ])
    expect(logs.error).toBeNull()
  })

  afterAll(async () => {
    await cleanupUser(user)
    // Remove only the two accounting rows this test created.
    await admin.from('generation_logs').delete().eq('model', LOG_MODEL_MARKER)
  })

  it('reports what it removed', async () => {
    const result = await deleteAccount(user!.client, user!.userId)
    expect(result).not.toBeNull()
    expect(result!.family_id).toBe(familyId)
    expect(result!.removed).toEqual({ children: 2, series: 1, story_bibles: 1, stories: 1 })
  })

  it.each(['children', 'series', 'story_bibles', 'stories', 'daily_usage'] as const)(
    'leaves zero %s rows for that family',
    async (table) => {
      const { count, error } = await admin
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('family_id', familyId)
      expect(error).toBeNull()
      expect(count).toBe(0)
    },
  )

  it('removes the families row itself', async () => {
    const { count } = await admin
      .from('families')
      .select('*', { count: 'exact', head: true })
      .eq('id', familyId)
    expect(count).toBe(0)
  })

  it('keeps generation_logs with family_id set to null (F2 AC)', async () => {
    const { data, error } = await admin
      .from('generation_logs')
      .select('family_id,cost_usd,purpose')
      .eq('model', LOG_MODEL_MARKER)
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
    for (const row of data!) expect(row.family_id).toBeNull()
    // The cost history itself is intact - that is the whole point of keeping the rows.
    expect(data!.map((r) => r.purpose).sort()).toEqual(['quality', 'write'])
  })

  it('a second delete is a no-op rather than an error', async () => {
    expect(await deleteAccount(user!.client, user!.userId)).toBeNull()
  })
})
