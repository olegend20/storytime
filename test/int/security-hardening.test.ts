import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { ensureFamily } from '@/lib/family/service'
import {
  anonClient,
  cleanupUser,
  createTestUser,
  localDb,
  localDbAvailable,
  serviceClient,
  SKIP_REASON,
  type TestUser,
} from './support/lane1-db'

/**
 * The 2026-09-29 security audit, as attacks through the PUBLIC API - the anon key and a
 * signed-in user's own JWT are all an attacker has. Each test is one finding; each must be
 * refused. Migration 20260929000001_security_hardening.sql and supabase/config.toml.
 */

const dbUp = await localDbAvailable()
if (!dbUp) console.warn(`[security int] skipped: ${SKIP_REASON}`)

describe.runIf(dbUp)('security audit 2026-09-29: attacks through the public API', () => {
  let user: TestUser
  let familyId: string
  let storyId: string
  let seriesId: string

  beforeAll(async () => {
    user = await createTestUser('security')
    familyId = (await ensureFamily(user.client, user.userId)).id
    const db = serviceClient()
    const { data: child } = await db
      .from('children')
      .insert({ family_id: familyId, first_name: 'Cruz', age: 7 })
      .select('id')
      .single()
    const { data: series } = await db
      .from('series')
      .insert({ family_id: familyId, child_ids: [child!.id], child_key: child!.id })
      .select('id')
      .single()
    seriesId = series!.id as string
    await db.from('story_bibles').insert({
      series_id: seriesId,
      family_id: familyId,
      content: {},
      version: 1,
    })
    const { data: story, error } = await db
      .from('stories')
      .insert({
        family_id: familyId,
        series_id: seriesId,
        topic_input: 'sharks',
        topic_key: 'sharks',
        tones: ['funny'],
        length_minutes: 5,
        age_band: 'B',
        title: 'Original title',
        content: {},
        status: 'ready',
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    storyId = story!.id as string
  })

  afterAll(async () => {
    await cleanupUser(user)
  })

  it('anon cannot read, write or empty any table', async () => {
    const anon = anonClient()
    for (const table of ['children', 'families', 'stories', 'fact_packs', 'generation_logs']) {
      const { error } = await anon.from(table).select('*').limit(1)
      expect(error?.code, `anon select on ${table}`).toBe('42501')
    }
    const { error } = await anon.from('children').insert({ family_id: familyId, first_name: 'X', age: 5 })
    expect(error?.code).toBe('42501')
  })

  it('nobody outside the server can call the retention purge (SECURITY DEFINER)', async () => {
    for (const client of [anonClient(), user.client]) {
      const { error } = await client.rpc('purge_guardrail_raw_text')
      expect(error?.code).toBe('42501')
    }
  })

  it('a signed-in user cannot write a story bible directly (prompt-cost abuse)', async () => {
    const huge = { avoid: ['x'.repeat(100_000)] }
    const update = await user.client.from('story_bibles').update({ content: huge }).eq('series_id', seriesId)
    expect(update.error?.code).toBe('42501')
    const insert = await user.client
      .from('story_bibles')
      .insert({ series_id: seriesId, family_id: familyId, content: huge, version: 99 })
    expect(insert.error?.code).toBe('42501')
  })

  it('a signed-in user cannot insert or edit stories or series directly', async () => {
    const edit = await user.client.from('stories').update({ title: 'Hacked' }).eq('id', storyId)
    expect(edit.error?.code).toBe('42501')
    const add = await user.client.from('series').insert({ family_id: familyId, child_ids: [], child_key: 'x' })
    expect(add.error?.code).toBe('42501')
    const { data } = await serviceClient().from('stories').select('title').eq('id', storyId).single()
    expect(data!.title).toBe('Original title')
  })

  it('but can still read and delete their own stories (F9)', async () => {
    const read = await user.client.from('stories').select('id').eq('id', storyId)
    expect(read.data).toHaveLength(1)
    const del = await user.client.from('stories').delete().eq('id', storyId).select('id')
    expect(del.data).toHaveLength(1)
  })

  it('a child cannot carry an oversized like, whoever writes it', async () => {
    const { error } = await user.client
      .from('children')
      .insert({ family_id: familyId, first_name: 'Maya', age: 6, likes: ['y'.repeat(41)] })
    expect(error?.code).toBe('23514')
    const ok = await user.client
      .from('children')
      .insert({ family_id: familyId, first_name: 'Maya', age: 6, likes: ['y'.repeat(40)] })
      .select('id')
    expect(ok.error).toBeNull()
  })

  it('password sign-up with someone else’s email does not sign anyone in', async () => {
    const client = createClient(localDb.url, localDb.anonKey, { auth: { persistSession: false } })
    const email = `not-theirs-${Date.now()}@storytime.test`
    const { data, error } = await client.auth.signUp({ email, password: 'correct-horse-battery-9' })
    expect(error).toBeNull()
    expect(data.session, 'an unconfirmed signup must not get a session').toBeNull()
    const login = await client.auth.signInWithPassword({ email, password: 'correct-horse-battery-9' })
    expect(login.data.session).toBeNull()
    if (data.user) await serviceClient().auth.admin.deleteUser(data.user.id)
  })
})
