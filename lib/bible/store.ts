import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { StoryBible, type StoryBibleRecord } from '@/lib/schemas'
import { childKey, sortedChildIds } from './keys'
import { enforceBibleLimits, estimateBibleTokens } from './limits'
import { loadChildProfiles, toBibleChild, type ChildProfile } from './children'

/**
 * Series and Story Bible persistence (F4).
 *
 * Every write goes through `writeBible`, which enforces the 800-token cap and uses
 * optimistic concurrency on `version`: a stale writer loses and retries rather than
 * clobbering a concurrent update.
 */

export interface SeriesRecord {
  id: string
  family_id: string
  child_ids: string[]
  child_key: string
  title: string | null
}

/** Raised when the conditional update matched no row: someone else wrote first. */
export class BibleVersionConflict extends Error {
  constructor(
    readonly seriesId: string,
    readonly expectedVersion: number,
  ) {
    super(`story_bibles for series ${seriesId} is no longer at version ${expectedVersion}`)
    this.name = 'BibleVersionConflict'
  }
}

/**
 * The series for this exact set of children, created on first use together with an empty
 * bible built from the child profiles only (F4 AC: no recurring characters yet).
 */
export async function getOrCreateSeries(
  familyId: string,
  childIds: readonly string[],
  db: SupabaseClient = supabaseService(),
): Promise<SeriesRecord> {
  const key = childKey(childIds)
  const ids = sortedChildIds(childIds)

  const existing = await findSeries(familyId, key, db)
  if (existing) return existing

  const { data, error } = await db
    .from('series')
    .insert({ family_id: familyId, child_ids: ids, child_key: key })
    .select('id, family_id, child_ids, child_key, title')
    .maybeSingle()

  if (error) {
    // Unique (family_id, child_key): a concurrent request created it first. Read it back.
    const raced = await findSeries(familyId, key, db)
    if (raced) return raced
    throw new Error(`getOrCreateSeries: ${error.message}`)
  }
  if (!data) throw new Error('getOrCreateSeries: insert returned no row')

  const series = data as SeriesRecord
  await ensureBible(series, childIds, db)
  return series
}

async function findSeries(
  familyId: string,
  key: string,
  db: SupabaseClient,
): Promise<SeriesRecord | null> {
  const { data, error } = await db
    .from('series')
    .select('id, family_id, child_ids, child_key, title')
    .eq('family_id', familyId)
    .eq('child_key', key)
    .maybeSingle()
  if (error) throw new Error(`findSeries: ${error.message}`)
  return (data as SeriesRecord | null) ?? null
}

/** A first bible for a brand-new series: the children, and nothing else. */
export function emptyBible(children: readonly ChildProfile[]): StoryBible {
  return {
    children: children.map((c) => toBibleChild(c)),
    recurring: [],
    catchphrases: [],
    topics_covered: [],
    last_story: null,
    tone_history: [],
    avoid: [],
  }
}

async function ensureBible(
  series: SeriesRecord,
  childIds: readonly string[],
  db: SupabaseClient,
): Promise<StoryBibleRecord> {
  const existing = await readBible(series.id, db)
  if (existing) return existing

  const children = await loadChildProfiles(series.family_id, childIds, db)
  const content = enforceBibleLimits(emptyBible(children))

  const { data, error } = await db
    .from('story_bibles')
    .insert({
      series_id: series.id,
      family_id: series.family_id,
      version: 1,
      content,
      token_estimate: estimateBibleTokens(content),
    })
    .select('id, series_id, family_id, version, content, token_estimate')
    .maybeSingle()

  if (error) {
    const raced = await readBible(series.id, db)
    if (raced) return raced
    throw new Error(`ensureBible: ${error.message}`)
  }
  return parseRecord(data)
}

async function readBible(
  seriesId: string,
  db: SupabaseClient,
): Promise<StoryBibleRecord | null> {
  const { data, error } = await db
    .from('story_bibles')
    .select('id, series_id, family_id, version, content, token_estimate')
    .eq('series_id', seriesId)
    .maybeSingle()
  if (error) throw new Error(`readBible: ${error.message}`)
  return data ? parseRecord(data) : null
}

function parseRecord(row: unknown): StoryBibleRecord {
  const r = row as Record<string, unknown>
  const content = StoryBible.safeParse(r.content)
  if (!content.success) {
    throw new Error(
      `story_bibles.content for series ${String(r.series_id)} does not match StoryBible: ` +
        content.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
  }
  return {
    id: String(r.id),
    series_id: String(r.series_id),
    family_id: String(r.family_id),
    version: Number(r.version),
    content: content.data,
    token_estimate: Number(r.token_estimate ?? 0),
  }
}

export interface LoadBibleOptions {
  db?: SupabaseClient
  /**
   * Current child profiles. When given, the bible's `children` block is refreshed from
   * them (F4 AC: "editing a child's age/likes propagates to the bible on next load").
   * `role_notes` is series memory and is preserved.
   */
  children?: readonly ChildProfile[]
  /** Needed only when the bible has to be created because none exists yet. */
  childIds?: readonly string[]
}

/**
 * The bible for a series. Creates one if the row is missing (a series always has a bible,
 * but a crash between the two inserts must not leave generation broken).
 */
export async function loadBible(
  seriesId: string,
  opts: LoadBibleOptions = {},
): Promise<StoryBibleRecord> {
  const db = opts.db ?? supabaseService()
  let record = await readBible(seriesId, db)

  if (!record) {
    const { data, error } = await db
      .from('series')
      .select('id, family_id, child_ids, child_key, title')
      .eq('id', seriesId)
      .maybeSingle()
    if (error) throw new Error(`loadBible: ${error.message}`)
    if (!data) throw new Error(`loadBible: no series ${seriesId}`)
    const series = data as SeriesRecord
    record = await ensureBible(series, opts.childIds ?? series.child_ids, db)
  }

  if (opts.children && opts.children.length > 0) {
    const refreshed = refreshBibleChildren(record.content, opts.children)
    if (refreshed) {
      record = { ...record, content: refreshed }
      // Best-effort persist: a lost race here is harmless, the next load repeats it.
      try {
        record = await writeBible(record, refreshed, db)
      } catch (err) {
        if (!(err instanceof BibleVersionConflict)) throw err
        record = (await readBible(seriesId, db)) ?? record
      }
    }
  }

  return record
}

/**
 * Rebuild `children` from live profiles, keeping the `role_notes` the series has learned.
 * Returns null when nothing changed, so a read never causes a pointless write.
 */
export function refreshBibleChildren(
  content: StoryBible,
  children: readonly ChildProfile[],
): StoryBible | null {
  const notesByName = new Map(content.children.map((c) => [c.name, c.role_notes ?? null]))
  const next = children.map((c) => toBibleChild(c, notesByName.get(c.first_name) ?? null))
  if (JSON.stringify(next) === JSON.stringify(content.children)) return null
  return { ...content, children: next }
}

/**
 * Single atomic write with `version + 1` (§4.2). The update is conditional on the version
 * we read, so two concurrent updates cannot both succeed.
 */
export async function writeBible(
  record: StoryBibleRecord,
  content: StoryBible,
  db: SupabaseClient = supabaseService(),
): Promise<StoryBibleRecord> {
  const trimmed = enforceBibleLimits(content)
  const { data, error } = await db
    .from('story_bibles')
    .update({
      content: trimmed,
      token_estimate: estimateBibleTokens(trimmed),
      version: record.version + 1,
    })
    .eq('series_id', record.series_id)
    .eq('version', record.version)
    .select('id, series_id, family_id, version, content, token_estimate')
    .maybeSingle()

  if (error) throw new Error(`writeBible: ${error.message}`)
  if (!data) throw new BibleVersionConflict(record.series_id, record.version)
  return parseRecord(data)
}

/** Fresh read of the bible, for a retry after a version conflict. */
export async function reloadBible(
  seriesId: string,
  db: SupabaseClient = supabaseService(),
): Promise<StoryBibleRecord> {
  const record = await readBible(seriesId, db)
  if (!record) throw new Error(`reloadBible: no bible for series ${seriesId}`)
  return record
}
