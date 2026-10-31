import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { STALE_AFTER_MS, finishGenerationRequest, startGenerationRequest } from '@/lib/generate/requests'
import {
  PROGRESS_RETENTION_MS,
  ProgressRecorder,
  pruneGenerationProgress,
  readGenerationProgress,
} from '@/lib/generate/progress'
import { streamSourceStory } from '@/lib/mock/store'
import { generationEvents } from '@/lib/mock/stream'
import type { SseEvent } from '@/lib/schemas'
import { createTestFamily, databaseAvailable, type TestFamily } from '../helpers/pipeline-db'
import { anon } from '../helpers/db'

/**
 * Issue #82, against the local database: the story so far for a page that lost its stream.
 * VT-RC3 (the read the progress endpoint makes) and VT-RC7 (the table: no client access, and
 * old snapshots pruned).
 */
const available = await databaseAvailable()

const events = generationEvents(streamSourceStory(0), { scenario: 'ok', delayMs: 0, quota: { used: 1, limit: 3 } }) as SseEvent[]

describe.skipIf(!available)('generation_progress (int)', () => {
  let family: TestFamily
  let other: TestFamily

  beforeAll(async () => {
    family = await createTestFamily({ label: 'genprog' })
    other = await createTestFamily({ label: 'genprog-other' })
  })
  afterAll(async () => {
    await family?.cleanup()
    await other?.cleanup()
  })

  it('VT-RC3: the story so far comes back only when it is newer than the page\'s version', async () => {
    const id = randomUUID()
    await startGenerationRequest(family.db, id, family.familyId)
    expect(await readGenerationProgress(family.db, family.familyId, id, 0)).toEqual({
      status: 'writing',
      story_id: null,
      version: 0,
      events: null,
    })

    const recorder = new ProgressRecorder(family.db, id, family.familyId)
    const half = events.slice(0, Math.floor(events.length / 2))
    for (const event of half) recorder.observe(event)
    await recorder.settled()
    const first = await readGenerationProgress(family.db, family.familyId, id, 0)
    expect(first?.status).toBe('writing')
    expect(first?.version).toBeGreaterThan(0)
    expect(first?.events?.[0]).toMatchObject({ type: 'facts' })
    // Asking with the version it has: nothing to send.
    expect((await readGenerationProgress(family.db, family.familyId, id, first!.version))?.events).toBeNull()

    for (const event of events.slice(half.length)) recorder.observe(event)
    await recorder.settled()
    await finishGenerationRequest(family.db, id, family.familyId, { status: 'ready', storyId: (events[1] as { story_id: string }).story_id })
    const last = await readGenerationProgress(family.db, family.familyId, id, first!.version)
    expect(last).toMatchObject({ status: 'ready' })
    expect(last?.version).toBeGreaterThan(first!.version)
    expect(last?.events?.at(-1)).toMatchObject({ type: 'done' })
    expect(recorder.stats.failures).toBe(0)
  })

  it('VT-RC3: another family\'s request is not there, as on the #59 read', async () => {
    const id = randomUUID()
    await startGenerationRequest(family.db, id, family.familyId)
    const recorder = new ProgressRecorder(family.db, id, family.familyId)
    recorder.observe(events[0]!)
    await recorder.settled()
    expect(await readGenerationProgress(other.db, other.familyId, id, 0)).toBeNull()
  })

  it('VT-RC7: no client key can read or write it', async () => {
    const client = anon()
    const read = await client.from('generation_progress').select('*').limit(1)
    expect(read.error?.message).toMatch(/permission denied/i)
    const write = await client.from('generation_progress').insert({ generation_id: randomUUID(), family_id: family.familyId, version: 1, events: [] })
    expect(write.error?.message).toMatch(/permission denied/i)
  })

  it('VT-RC7: an unsaved story whose request was killed before it finished loses its snapshot at the next prune', async () => {
    const killed = randomUUID()
    const discarded = randomUUID()
    const saved = randomUUID()
    for (const id of [killed, discarded, saved]) {
      await startGenerationRequest(family.db, id, family.familyId)
      const recorder = new ProgressRecorder(family.db, id, family.familyId)
      recorder.observe(events[0]!)
      await recorder.settled()
    }
    await family.db.from('generation_requests').update({ started_at: new Date(Date.now() - STALE_AFTER_MS - 60_000).toISOString() }).eq('id', killed)
    await family.db.from('generation_requests').update({ status: 'discarded' }).eq('id', discarded)
    await family.db.from('generation_requests').update({ status: 'ready' }).eq('id', saved)
    await pruneGenerationProgress(family.db)
    const { data } = await family.db.from('generation_progress').select('generation_id').in('generation_id', [killed, discarded, saved])
    expect((data ?? []).map((r) => r.generation_id)).toEqual([saved])
  })

  it('VT-RC7: snapshots older than an hour are pruned, newer ones kept', async () => {
    const old = randomUUID()
    const fresh = randomUUID()
    for (const id of [old, fresh]) {
      await startGenerationRequest(family.db, id, family.familyId)
      const recorder = new ProgressRecorder(family.db, id, family.familyId)
      recorder.observe(events[0]!)
      await recorder.settled()
    }
    const stamp = new Date(Date.now() - PROGRESS_RETENTION_MS - 60_000).toISOString()
    await family.db.from('generation_progress').update({ updated_at: stamp }).eq('generation_id', old)
    await pruneGenerationProgress(family.db)
    const { data } = await family.db.from('generation_progress').select('generation_id').in('generation_id', [old, fresh])
    expect((data ?? []).map((r) => r.generation_id)).toEqual([fresh])
  })
})
