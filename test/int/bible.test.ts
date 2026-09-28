import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BibleVersionConflict,
  getOrCreateSeries,
  loadBible,
  reloadBible,
  updateBibleFromStory,
  writeBible,
  bibleFitsLimit,
} from '@/lib/bible'
import { MemoryLogSink } from '@/lib/ai'
import { createTestFamily, databaseAvailable, type TestFamily } from '../helpers/pipeline-db'
import { goodStory } from '../helpers/story'

/**
 * F4 integration tests against the local Supabase.
 *
 * The bible-update model call is deliberately left un-fixtured in most of these: with no
 * recorded fixture the helper call fails, which is exactly the path that exercises "retried
 * up to 3 times" and then the no-model fallback. Continuity must survive a dead helper
 * model, and this is the only way to prove it.
 */

const available = await databaseAvailable()
/**
 * The two tests below that call `updateBibleFromStory` are designed around the helper model
 * being UNAVAILABLE (no fixture), which is what exercises the 3-retry budget and the no-model
 * fallback. Recording would create fixtures and turn them into tests of the model instead, so
 * they are skipped while recording. The real Haiku path has its own test in bible-update.test.ts.
 */
const RECORDING = process.env.RECORD_FIXTURES === '1' || process.env.RECORD_FIXTURES === 'true'
const SKIP_REASON =
  'local Supabase not reachable at 127.0.0.1:54321 - run `supabase start` to include these'

describe.skipIf(!available)(`F4 series and bible (int) ${available ? '' : `- SKIPPED: ${SKIP_REASON}`}`, () => {
  let family: TestFamily

  beforeAll(async () => {
    family = await createTestFamily({ label: 'f4' })
  })
  afterAll(async () => {
    await family?.cleanup()
  })

  it('keys a series by the exact sorted set of children', async () => {
    const ids = family.children.map((c) => c.id)
    const first = await getOrCreateSeries(family.familyId, ids, family.db)
    const reversed = await getOrCreateSeries(family.familyId, [...ids].reverse(), family.db)
    expect(reversed.id).toBe(first.id)
    expect(first.child_ids).toEqual([...ids].sort())

    // One child alone is a different series with its own recurring characters.
    const solo = await getOrCreateSeries(family.familyId, [ids[0]!], family.db)
    expect(solo.id).not.toBe(first.id)
  })

  it('builds a new series bible from the child profiles only, at version 1', async () => {
    const series = await getOrCreateSeries(
      family.familyId,
      [family.children[1]!.id],
      family.db,
    )
    const bible = await loadBible(series.id, { db: family.db })
    expect(bible.version).toBe(1)
    expect(bible.content.children.map((c) => c.name)).toEqual([family.children[1]!.first_name])
    expect(bible.content.recurring).toEqual([])
    expect(bible.content.last_story).toBeNull()
    expect(bible.token_estimate).toBeGreaterThan(0)
    expect(bibleFitsLimit(bible.content)).toBe(true)
  })

  it('propagates an edited age to the bible on the next load', async () => {
    const child = family.children[0]!
    const series = await getOrCreateSeries(family.familyId, [child.id], family.db)
    await family.db.from('children').update({ age: 9, likes: ['LEGO', 'volcanoes'] }).eq('id', child.id)

    const refreshed = await loadBible(series.id, {
      db: family.db,
      children: [
        {
          id: child.id,
          first_name: child.first_name,
          age: 9,
          likes: ['LEGO', 'volcanoes'],
          notes: null,
          reading_level: null,
        },
      ],
    })
    expect(refreshed.content.children[0]?.age).toBe(9)
    expect(refreshed.content.children[0]?.likes).toEqual(['LEGO', 'volcanoes'])

    await family.db.from('children').update({ age: child.age, likes: ['LEGO', 'sharks'] }).eq('id', child.id)
  })

  it.skipIf(RECORDING)('F4 VT: two stories for the same children share one series, one version bump each', async () => {
    const ids = family.children.map((c) => c.id)
    const series = await getOrCreateSeries(family.familyId, ids, family.db)
    const before = await reloadBible(series.id, family.db)

    // Two nights, same children. Both stories must land on the same series row.
    const storyIds: string[] = []
    for (const [index, topic] of ['history of LEGO', 'sharks'].entries()) {
      const { data, error } = await family.db
        .from('stories')
        .insert({
          family_id: family.familyId,
          series_id: series.id,
          topic_input: topic,
          topic_key: topic.replace(/\s+/g, '-').toLowerCase(),
          tones: ['funny'],
          length_minutes: 10,
          age_band: 'A',
          title: `Night ${index + 1}`,
          content: goodStory(),
          word_count: 1500,
          quality: {},
          status: 'ready',
        })
        .select('id, series_id')
        .single()
      if (error) throw new Error(error.message)
      storyIds.push((data as { id: string }).id)
      expect((data as { series_id: string }).series_id).toBe(series.id)

      // One bible update per story, one version bump per update.
      const result = await updateBibleFromStory(series.id, goodStory(), {
        db: family.db,
        sink: new MemoryLogSink(),
        topic,
        tones: ['funny'],
        date: `2026-09-2${6 + index}`,
      })
      expect(result.record.version).toBe(before.version + index + 1)
    }

    const after = await reloadBible(series.id, family.db)
    expect(after.version).toBe(before.version + 2)
    expect(after.content.topics_covered.map((t) => t.topic)).toEqual(
      expect.arrayContaining(['history of LEGO', 'sharks']),
    )
    await family.db.from('stories').delete().in('id', storyIds)
  })

  it('F4 VT: two concurrent writes at the same version - one wins, the loser conflicts', async () => {
    const series = await getOrCreateSeries(family.familyId, family.children.map((c) => c.id), family.db)
    const before = await reloadBible(series.id, family.db)

    const results = await Promise.allSettled([
      writeBible(before, { ...before.content, catchphrases: ['Play well'] }, family.db),
      writeBible(before, { ...before.content, catchphrases: ['Swim well'] }, family.db),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BibleVersionConflict)

    const after = await reloadBible(series.id, family.db)
    expect(after.version).toBe(before.version + 1)
  })

  it.skipIf(RECORDING)('F4 VT: two concurrent updateBibleFromStory both succeed, with merged content', async () => {
    const series = await getOrCreateSeries(
      family.familyId,
      [family.children[0]!.id, family.children[1]!.id],
      family.db,
    )
    const before = await reloadBible(series.id, family.db)

    const legoStory = goodStory()
    const sharkStory = {
      ...goodStory(),
      title: 'Cruz, Phoenix and the Shark Submarine',
      bible_suggestions: {
        new_recurring: [
          {
            name: 'Grandpa Greenie',
            type: 'character' as const,
            rule: '400-year-old Greenland shark guide; slow, kind, jokes about being old',
          },
        ],
        ending_summary: 'A shark tooth appeared on the bedroom floor.',
      },
    }

    const [a, b] = await Promise.all([
      updateBibleFromStory(series.id, legoStory, {
        db: family.db,
        sink: new MemoryLogSink(),
        topic: 'history of LEGO',
        tones: ['funny'],
        date: '2026-09-26',
      }),
      updateBibleFromStory(series.id, sharkStory, {
        db: family.db,
        sink: new MemoryLogSink(),
        topic: 'sharks',
        tones: ['exciting'],
        date: '2026-09-27',
      }),
    ])

    // Both completed. At least one had to retry after a version conflict.
    expect(a.record.version).toBeGreaterThan(before.version)
    expect(b.record.version).toBeGreaterThan(before.version)
    expect(a.conflicts + b.conflicts).toBeGreaterThanOrEqual(1)

    const after = await reloadBible(series.id, family.db)
    expect(after.version).toBe(before.version + 2)

    // Neither writer's content was lost.
    const topics = after.content.topics_covered.map((t) => t.topic)
    expect(topics).toContain('history of LEGO')
    expect(topics).toContain('sharks')
    expect(after.content.recurring.map((r) => r.name)).toContain('Grandpa Greenie')
    expect(bibleFitsLimit(after.content)).toBe(true)
  })

  it.skipIf(RECORDING)('retries the helper model up to 3 times, then keeps continuity without it', async () => {
    const series = await getOrCreateSeries(family.familyId, [family.children[1]!.id], family.db)
    const before = await reloadBible(series.id, family.db)
    const sink = new MemoryLogSink()

    // No fixture is recorded for this exact input, so every model attempt fails.
    const result = await updateBibleFromStory(series.id, goodStory(), {
      db: family.db,
      sink,
      topic: 'history of LEGO',
      tones: ['funny'],
      date: '2026-09-27',
    })

    expect(result.attempts).toBe(3)
    expect(result.usedFallback).toBe(true)
    expect(result.errors).toHaveLength(3)
    // Continuity survived: the ending and the topic are recorded anyway.
    expect(result.record.version).toBe(before.version + 1)
    expect(result.record.content.last_story?.title).toBe(goodStory().title)
    expect(result.record.content.topics_covered.map((t) => t.topic)).toContain('history of LEGO')
    expect(result.record.token_estimate).toBeLessThanOrEqual(800)
  })
})
