import type { SupabaseClient } from '@supabase/supabase-js'
import { LibraryStory, SuggestedTopicsResponse } from '@/lib/schemas'

/**
 * F9/F10 server side: the library list, one story, delete, and the suggested-topic chips.
 *
 * Lane 4 built the UI against `/api/mock/*` and nobody built the real routes, so outside
 * mock mode the library, the reader and the chips had nothing to call. Every function takes
 * the CALLER's RLS client: `stories`, `series` and `children` are family-scoped by policy,
 * so one family can never read or delete another's stories, whatever id it sends.
 *
 * Reading a story makes zero model calls (F9 AC) - these are plain selects.
 */

const STORY_COLUMNS =
  'id, family_id, series_id, topic_input, topic_key, fact_pack_id, tones, length_minutes, age_band, title, content, word_count, status, created_at'

interface StoryRow {
  id: string
  family_id: string
  series_id: string
  topic_input: string
  topic_key: string
  fact_pack_id: string | null
  tones: string[]
  length_minutes: number
  age_band: string
  title: string
  content: unknown
  word_count: number
  status: string
  created_at: string
}

/** Stories a parent can read. `failed` rows have no usable content. */
const READABLE = ['ready', 'flagged']

async function decorate(db: SupabaseClient, rows: StoryRow[]): Promise<LibraryStory[]> {
  if (rows.length === 0) return []
  const seriesIds = [...new Set(rows.map((r) => r.series_id))]
  const packIds = [...new Set(rows.map((r) => r.fact_pack_id).filter((id): id is string => !!id))]

  const [{ data: series }, { data: siblings }, { data: packs }] = await Promise.all([
    db.from('series').select('id, title, child_ids').in('id', seriesIds),
    // Sequence is the story's position among its series' stories that still exist.
    db
      .from('stories')
      .select('id, series_id, created_at')
      .in('series_id', seriesIds)
      .in('status', READABLE)
      .order('created_at', { ascending: true }),
    packIds.length > 0
      ? db.from('fact_packs').select('id, topic_label').in('id', packIds)
      : Promise.resolve({ data: [] as { id: string; topic_label: string }[] }),
  ])

  const childIds = [...new Set((series ?? []).flatMap((s) => (s.child_ids as string[]) ?? []))]
  const { data: children } =
    childIds.length > 0
      ? await db.from('children').select('id, first_name, age').in('id', childIds)
      : { data: [] as { id: string; first_name: string; age: number }[] }
  const childById = new Map(
    (children ?? []).map((c) => [c.id as string, { name: c.first_name as string, age: c.age as number }]),
  )

  const seriesById = new Map((series ?? []).map((s) => [s.id as string, s]))
  const labelOf = new Map((packs ?? []).map((p) => [p.id as string, p.topic_label as string]))
  const sequenceOf = new Map<string, number>()
  const counter = new Map<string, number>()
  for (const s of siblings ?? []) {
    const n = (counter.get(s.series_id as string) ?? 0) + 1
    counter.set(s.series_id as string, n)
    sequenceOf.set(s.id as string, n)
  }

  return rows.map((row) => {
    const s = seriesById.get(row.series_id)
    // Oldest first, then by name: `child_ids` is stored in uuid order, which is random, so
    // "Cruz & Phoenix" would otherwise flip to "Phoenix & Cruz" between families and runs.
    const names = ((s?.child_ids as string[] | undefined) ?? [])
      .map((id) => childById.get(id))
      .filter((c): c is { name: string; age: number } => !!c)
      .sort((a, b) => b.age - a.age || a.name.localeCompare(b.name))
      .map((c) => c.name)
    return LibraryStory.parse({
      ...row,
      series_title: (s?.title as string | null) || joinNames(names) || 'Your stories',
      sequence: sequenceOf.get(row.id) ?? 1,
      child_names: names,
      topic_label: (row.fact_pack_id && labelOf.get(row.fact_pack_id)) || row.topic_input,
    })
  })
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
}

/** GET /api/stories - newest first. */
export async function listLibrary(db: SupabaseClient): Promise<LibraryStory[]> {
  const { data, error } = await db
    .from('stories')
    .select(STORY_COLUMNS)
    .in('status', READABLE)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`listLibrary: ${error.message}`)
  return decorate(db, (data ?? []) as StoryRow[])
}

/** GET /api/stories/:id - null when it does not exist or is not the caller's. */
export async function getLibraryStory(db: SupabaseClient, id: string): Promise<LibraryStory | null> {
  if (!UUID.test(id)) return null
  const { data, error } = await db
    .from('stories')
    .select(STORY_COLUMNS)
    .eq('id', id)
    .in('status', READABLE)
    .maybeSingle()
  if (error) throw new Error(`getLibraryStory: ${error.message}`)
  if (!data) return null
  const [story] = await decorate(db, [data as StoryRow])
  return story ?? null
}

/**
 * DELETE /api/stories/:id - false when there was nothing of the caller's to delete.
 * F9: the Story Bible is NOT rolled back (documented behaviour).
 */
export async function deleteLibraryStory(db: SupabaseClient, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false
  const { data, error } = await db.from('stories').delete().eq('id', id).select('id')
  if (error) throw new Error(`deleteLibraryStory: ${error.message}`)
  return (data ?? []).length > 0
}

/**
 * GET /api/topics/suggested - the most-used ready fact packs, which generate instantly.
 * Appendix B #3 default is "4 + 4": four from here, the client pads with evergreen ideas
 * (`lib/client/topics.ts`).
 */
export const WARM_SUGGESTIONS = 4

export async function suggestedTopics(db: SupabaseClient): Promise<SuggestedTopicsResponse> {
  const { data, error } = await db
    .from('fact_packs')
    .select('topic_key, topic_label, use_count')
    .eq('status', 'ready')
    .order('use_count', { ascending: false })
    .order('topic_key', { ascending: true })
    .limit(WARM_SUGGESTIONS)
  if (error) throw new Error(`suggestedTopics: ${error.message}`)
  return SuggestedTopicsResponse.parse({
    topics: (data ?? []).map((p) => ({
      label: p.topic_label as string,
      topic_key: p.topic_key as string,
      warm: true,
    })),
  })
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
