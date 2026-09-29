import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureFamily } from '@/lib/family/service'
import { getOrCreateSeries, loadBible } from '@/lib/bible'
import { LibraryStory } from '@/lib/schemas'
import {
  deleteLibraryStory,
  getLibraryStory,
  listLibrary,
  suggestedTopics,
  WARM_SUGGESTIONS,
} from '@/lib/stories/library'
import { stubStory } from '../helpers/fixtures'
import {
  cleanupUser,
  createTestUser,
  localDbAvailable,
  serviceClient,
  SKIP_REASON,
  type TestUser,
} from './support/lane1-db'

/**
 * F9 server side: the REAL `/api/stories`, `/api/stories/:id` and `/api/topics/suggested`.
 *
 * Lane 4 built and tested the UI against `/api/mock/*`; these routes did not exist, so the
 * library, reader, delete and topic chips could not work outside mock mode. Every call here
 * runs as a signed-in user through RLS, which is what keeps one family's stories from another.
 *
 * Includes the F9 int VT: "delete story -> 404 on its URL; other stories in the series intact."
 */

const dbUp = await localDbAvailable()
if (!dbUp) console.warn(`[F9 int] skipped: ${SKIP_REASON}`)

describe.runIf(dbUp)('F9 library, reader and delete (real routes, RLS)', () => {
  let parent: TestUser
  let stranger: TestUser
  let seriesId: string
  const storyIds: string[] = []

  beforeAll(async () => {
    parent = await createTestUser('library')
    stranger = await createTestUser('library-stranger')
    const family = await ensureFamily(parent.client, parent.userId)
    await ensureFamily(stranger.client, stranger.userId)

    const db = serviceClient()
    const { data: kids, error: kidsErr } = await db
      .from('children')
      .insert([
        { family_id: family.id, first_name: 'Cruz', age: 7, likes: ['LEGO'] },
        { family_id: family.id, first_name: 'Phoenix', age: 4, likes: [] },
      ])
      .select('id, first_name')
    if (kidsErr || !kids) throw new Error(kidsErr?.message)
    const ids = ['Cruz', 'Phoenix'].map((n) => kids.find((k) => k.first_name === n)!.id as string)
    seriesId = (await getOrCreateSeries(family.id, ids, db)).id
    await loadBible(seriesId, { db })

    // Two readable stories a minute apart, then a failed one that must never be listed.
    const rows = [
      { title: 'The Brick That Clicked', at: '2026-09-27T19:00:00Z', status: 'ready' },
      { title: 'The Shark Who Sang', at: '2026-09-28T19:00:00Z', status: 'flagged' },
      { title: 'Never Finished', at: '2026-09-28T20:00:00Z', status: 'failed' },
    ]
    for (const r of rows) {
      const { data, error } = await db
        .from('stories')
        .insert({
          family_id: family.id,
          series_id: seriesId,
          topic_input: `topic for ${r.title}`,
          topic_key: 'history-of-lego',
          tones: ['funny'],
          length_minutes: 10,
          age_band: 'A',
          title: r.title,
          content: stubStory({ title: r.title }),
          word_count: 900,
          status: r.status,
          created_at: r.at,
        })
        .select('id')
        .single()
      if (error || !data) throw new Error(error?.message)
      storyIds.push(data.id as string)
    }
  })

  afterAll(async () => {
    await cleanupUser(parent)
    await cleanupUser(stranger)
  })

  it('lists the family’s readable stories, newest first, in the contract shape', async () => {
    const stories = await listLibrary(parent.client)
    expect(stories.map((s) => s.title)).toEqual(['The Shark Who Sang', 'The Brick That Clicked'])
    for (const s of stories) expect(LibraryStory.safeParse(s).success).toBe(true)

    const [newest, oldest] = stories
    expect(newest!.series_title).toBe('Cruz & Phoenix')
    expect(newest!.child_names).toEqual(['Cruz', 'Phoenix'])
    expect(oldest!.sequence).toBe(1)
    expect(newest!.sequence).toBe(2)
    // No fact pack on these rows: the label falls back to what the parent typed.
    expect(newest!.topic_label).toBe('topic for The Shark Who Sang')
  })

  it('never lists a failed story', async () => {
    const stories = await listLibrary(parent.client)
    expect(stories.map((s) => s.id)).not.toContain(storyIds[2])
    expect(await getLibraryStory(parent.client, storyIds[2]!)).toBeNull()
  })

  it('shows another family nothing - not in the list, not by id', async () => {
    expect(await listLibrary(stranger.client)).toEqual([])
    expect(await getLibraryStory(stranger.client, storyIds[0]!)).toBeNull()
  })

  it('opens one story with its full content', async () => {
    const story = await getLibraryStory(parent.client, storyIds[0]!)
    expect(story?.title).toBe('The Brick That Clicked')
    expect(story?.content.chapters.length).toBeGreaterThan(0)
  })

  it('treats a malformed id as not found rather than an error', async () => {
    expect(await getLibraryStory(parent.client, 'not-a-uuid')).toBeNull()
    expect(await deleteLibraryStory(parent.client, 'not-a-uuid')).toBe(false)
  })

  it('refuses to delete another family’s story, and it survives', async () => {
    expect(await deleteLibraryStory(stranger.client, storyIds[0]!)).toBe(false)
    expect(await getLibraryStory(parent.client, storyIds[0]!)).not.toBeNull()
  })

  it('F9 VT: delete -> not found; the other story in the series and the bible are intact', async () => {
    const bibleBefore = await loadBible(seriesId, { db: serviceClient() })

    expect(await deleteLibraryStory(parent.client, storyIds[1]!)).toBe(true)
    expect(await getLibraryStory(parent.client, storyIds[1]!)).toBeNull()
    expect(await deleteLibraryStory(parent.client, storyIds[1]!)).toBe(false)

    const remaining = await listLibrary(parent.client)
    expect(remaining.map((s) => s.id)).toEqual([storyIds[0]])
    // F9: the Story Bible is NOT rolled back.
    const bibleAfter = await loadBible(seriesId, { db: serviceClient() })
    expect(bibleAfter.version).toBe(bibleBefore.version)
  })

  it('suggests at most four warm topics, every one a ready fact pack', async () => {
    const { topics } = await suggestedTopics(parent.client)
    expect(topics.length).toBeLessThanOrEqual(WARM_SUGGESTIONS)
    const { data: ready } = await serviceClient()
      .from('fact_packs')
      .select('topic_key')
      .eq('status', 'ready')
    const readyKeys = new Set((ready ?? []).map((r) => r.topic_key as string))
    for (const t of topics) {
      expect(t.warm).toBe(true)
      expect(readyKeys.has(t.topic_key)).toBe(true)
    }
  })
})
