import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StoryBible, type StoryBible as StoryBibleType } from '@/lib/schemas'
import { MemoryLogSink } from '@/lib/ai'
import { getOrCreateSeries, reloadBible, updateBibleFromStory, writeBible } from '@/lib/bible'
import { referenceStoryOutput } from '@/lib/quality/reference'
import { loadManifest, loadReferenceStory, REFERENCE_DIR } from '@/lib/reference'
import { createTestFamily, databaseAvailable, type TestFamily } from '../helpers/db'

/**
 * F4 VT: "given old bible + reference story 'Shark Submarine', the Haiku update output
 * includes a recurring entry whose name contains 'Greenie' and `last_story.ending` mentions
 * a tooth."
 *
 * The inputs are the real ones: the prior bible the manifest records for that story, and the
 * reference story itself. The date is pinned so the prompt - and therefore the recorded
 * fixture - is deterministic.
 *
 * Record with:
 *   LIVE_API=1 RECORD_FIXTURES=1 npx vitest run test/int/bible-update.test.ts
 */

const available = await databaseAvailable()
const FIXED_DATE = '2026-09-27'

const manifest = loadManifest(REFERENCE_DIR)
const sharkEntry = manifest.stories.find((s) => s.file.includes('shark-submarine'))!

/** The manifest's `bible_before` in the StoryBible shape the service stores. */
function bibleBefore(): StoryBibleType {
  const before = sharkEntry.bible_before as {
    recurring?: { name: string; type: string; rule: string }[]
    catchphrases?: string[]
    topics_covered?: string[]
    last_story?: { title: string; ending: string }
  }
  return StoryBible.parse({
    // DECISIONS.md #23: the manifest leaves which boy is which open; the plan resolves it.
    children: [
      { name: 'Cruz', age: 7, likes: ['LEGO', 'sharks'], role_notes: 'often the one with the idea' },
      { name: 'Phoenix', age: 4, likes: ['dinosaurs'], role_notes: 'gets the shout-along lines' },
    ],
    recurring: (before.recurring ?? []).map((r) => ({ ...r, last_used: '2026-09-25' })),
    catchphrases: before.catchphrases ?? [],
    topics_covered: (before.topics_covered ?? []).map((topic) => ({
      topic,
      story_id: null,
      date: '2026-09-25',
    })),
    last_story: before.last_story ?? null,
    tone_history: ['funny', 'exciting'],
    avoid: [],
  })
}

describe.skipIf(!available)('F4 VT: the bible update on the Shark Submarine reference', () => {
  let family: TestFamily
  let seriesId: string

  beforeAll(async () => {
    family = await createTestFamily({ label: 'f4-update' })
    const series = await getOrCreateSeries(
      family.familyId,
      family.children.map((c) => c.id),
      family.db,
    )
    seriesId = series.id
    // Put the series into the state it was in the night before the shark story.
    const current = await reloadBible(seriesId, family.db)
    await writeBible(current, bibleBefore(), family.db)
  })
  afterAll(async () => {
    await family?.cleanup()
  })

  it('carries Grandpa Greenie and the shark tooth into the new bible', async () => {
    const story = referenceStoryOutput(loadReferenceStory(sharkEntry.file, REFERENCE_DIR))
    const sink = new MemoryLogSink()

    const result = await updateBibleFromStory(seriesId, story, {
      db: family.db,
      sink,
      topic: 'sharks',
      tones: ['funny', 'exciting'],
      date: FIXED_DATE,
    })

    // The helper model produced it, not the fallback.
    expect(result.usedFallback, `errors: ${result.errors.join(' | ')}`).toBe(false)
    expect(result.attempts).toBe(1)
    expect(sink.rows.filter((r) => r.purpose === 'bible_update')).toHaveLength(1)

    const bible = result.record.content
    expect(bible.recurring.map((r) => r.name).join(' | ')).toMatch(/Greenie/i)
    expect(bible.last_story?.ending.toLowerCase()).toContain('tooth')

    // The prior series memory survived the update.
    expect(bible.recurring.map((r) => r.name).join(' | ')).toMatch(/brick/i)
    expect(bible.topics_covered.map((t) => t.topic).join(' ')).toMatch(/shark/i)
    expect(bible.children.map((c) => c.name).sort()).toEqual(['Cruz', 'Phoenix'])

    // And it stayed inside the budget that makes the whole architecture work.
    expect(result.record.token_estimate).toBeLessThanOrEqual(800)
    expect(result.record.version).toBeGreaterThan(1)
  })
})
