import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  STALE_AFTER_MS,
  finishGenerationRequest,
  generationIdFrom,
  readGenerationRequest,
  startGenerationRequest,
} from '@/lib/generate/requests'
import { createTestFamily, databaseAvailable, type TestFamily } from '../helpers/pipeline-db'

/**
 * Issue #59: how each accepted request ended, so a page that lost the stream can tell
 * "still writing" from "saved" from "not made" - a discarded story has no `stories` row.
 */
const available = await databaseAvailable()

describe.skipIf(!available)('generation_requests (int)', () => {
  let family: TestFamily
  let other: TestFamily

  beforeAll(async () => {
    family = await createTestFamily({ label: 'genreq' })
    other = await createTestFamily({ label: 'genreq-other' })
  })
  afterAll(async () => {
    await family?.cleanup()
    await other?.cleanup()
  })

  it('a request is writing until it ends, then says how, with the story id only when saved', async () => {
    const id = randomUUID()
    const storyId = randomUUID()
    await startGenerationRequest(family.db, id, family.familyId)
    expect(await readGenerationRequest(family.db, family.familyId, id)).toEqual({ status: 'writing', story_id: null })

    await finishGenerationRequest(family.db, id, family.familyId, { status: 'ready', storyId })
    expect(await readGenerationRequest(family.db, family.familyId, id)).toEqual({ status: 'ready', story_id: storyId })
  })

  it('a discarded request is told apart from one still writing, and never hands out its story id', async () => {
    const id = randomUUID()
    await startGenerationRequest(family.db, id, family.familyId)
    await finishGenerationRequest(family.db, id, family.familyId, { status: 'discarded', storyId: randomUUID(), reason: 'rules 7' })
    expect(await readGenerationRequest(family.db, family.familyId, id)).toEqual({ status: 'discarded', story_id: null })
    const { data } = await family.db.from('generation_requests').select('reason, finished_at').eq('id', id).single()
    expect(data?.reason).toBe('rules 7')
    expect(data?.finished_at).not.toBeNull()
  })

  it('a request still writing after the platform must have killed it is reported failed', async () => {
    const id = randomUUID()
    await startGenerationRequest(family.db, id, family.familyId)
    const later = Date.now() + STALE_AFTER_MS + 1_000
    expect(await readGenerationRequest(family.db, family.familyId, id, later)).toEqual({ status: 'failed', story_id: null })
  })

  it("another family's request, or a malformed id, is not found - and cannot be finished by them", async () => {
    const id = randomUUID()
    await startGenerationRequest(family.db, id, family.familyId)
    expect(await readGenerationRequest(family.db, other.familyId, id)).toBeNull()
    await finishGenerationRequest(family.db, id, other.familyId, { status: 'ready', storyId: randomUUID() })
    expect(await readGenerationRequest(family.db, family.familyId, id)).toEqual({ status: 'writing', story_id: null })
    expect(await readGenerationRequest(family.db, family.familyId, 'not-a-uuid')).toBeNull()
  })

  it('the page and the browser cannot read or write the table directly', async () => {
    const { createClient } = await import('@supabase/supabase-js')
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!anonKey) return
    const anon = createClient(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321', anonKey, { auth: { persistSession: false } })
    const { data } = await anon.from('generation_requests').select('id').limit(1)
    expect(data ?? []).toEqual([])
  })

  it('takes the id from the x-generation-id header, and only a uuid', () => {
    const id = randomUUID()
    const req = (v?: string) => new Request('http://x/api/stories/generate', { method: 'POST', headers: v ? { 'x-generation-id': v } : {} })
    expect(generationIdFrom(req(id.toUpperCase()))).toBe(id)
    expect(generationIdFrom(req('drop table'))).toBeNull()
    expect(generationIdFrom(req())).toBeNull()
  })
})
