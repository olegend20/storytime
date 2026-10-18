import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * How each accepted story request ended (issue #59): the `generation_requests` table.
 *
 * The page sends an id with the request (`x-generation-id`). If its stream drops, it asks
 * `GET /api/stories/generate/{id}` instead of guessing from the library - a discarded story has no
 * `stories` row, so only this record can tell "still writing" from "not made". Recording is
 * best-effort: a failed write here is logged and never fails the story.
 */

export const GENERATION_ID_HEADER = 'x-generation-id'

export type GenerationRequestStatus = 'writing' | 'ready' | 'flagged' | 'discarded' | 'failed' | 'refused'

/**
 * A request still "writing" this long after it started is one the platform killed (the route's
 * `maxDuration` is 800 s) - reported as failed by the server's clock, not the phone's.
 * test/unit/deploy-config.test.ts ties it to the route.
 */
export const STALE_AFTER_MS = 860_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The id the page sent, or null for a missing or malformed one (an older page: not recorded). */
export function generationIdFrom(request: Request): string | null {
  const id = request.headers.get(GENERATION_ID_HEADER)
  return id && UUID.test(id) ? id.toLowerCase() : null
}

export async function startGenerationRequest(db: SupabaseClient, id: string, familyId: string): Promise<void> {
  try {
    const { error } = await db.from('generation_requests').insert({ id, family_id: familyId })
    if (error) console.warn(`[generate] generation_requests start: ${error.message}`)
  } catch (err) {
    console.warn('[generate] generation_requests start threw:', err)
  }
}

/**
 * The story's id, known once the request is prepared and before anything is written. If the
 * finish write is then lost, the read still finds the saved story by it (PR #60 review).
 */
export async function noteGenerationStory(db: SupabaseClient, id: string, familyId: string, storyId: string): Promise<void> {
  try {
    const { error } = await db
      .from('generation_requests')
      .update({ story_id: storyId })
      .eq('id', id)
      .eq('family_id', familyId)
      .eq('status', 'writing')
    if (error) console.warn(`[generate] generation_requests story id: ${error.message}`)
  } catch (err) {
    console.warn('[generate] generation_requests story id threw:', err)
  }
}

/**
 * Best-effort, and never throws: it runs after the story is saved, and a throw there would be
 * reported to the parent as a failure. Scoped to the family, because the page chose the id.
 */
export async function finishGenerationRequest(
  db: SupabaseClient,
  id: string,
  familyId: string,
  outcome: { status: Exclude<GenerationRequestStatus, 'writing'>; storyId: string | null; reason?: string | null },
): Promise<void> {
  try {
    const { error } = await db
      .from('generation_requests')
      .update({
        status: outcome.status,
        // A null here never erases the id noted when the request was prepared.
        ...(outcome.storyId ? { story_id: outcome.storyId } : {}),
        reason: outcome.reason?.slice(0, 200) ?? null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('family_id', familyId)
    if (error) console.warn(`[generate] generation_requests finish: ${error.message}`)
  } catch (err) {
    console.warn('[generate] generation_requests finish threw:', err)
  }
}

export interface GenerationRequestView {
  status: GenerationRequestStatus
  /** Set once the request ended in a saved story (`ready` or `flagged`). */
  story_id: string | null
}

/** One family's request, or null when there is none (or it belongs to another family). */
export async function readGenerationRequest(
  db: SupabaseClient,
  familyId: string,
  id: string,
  now: number = Date.now(),
): Promise<GenerationRequestView | null> {
  if (!UUID.test(id)) return null
  const { data, error } = await db
    .from('generation_requests')
    .select('status, story_id, started_at')
    .eq('id', id.toLowerCase())
    .eq('family_id', familyId)
    .maybeSingle()
  if (error) throw new Error(`generation_requests read: ${error.message}`)
  if (!data) return null
  const row = data as { status: GenerationRequestStatus; story_id: string | null; started_at: string }
  if ((row.status === 'writing' || row.status === 'failed') && row.story_id) {
    // Still "writing" with the finish write lost, or "failed" after the save (the quota step
    // threw): a saved story must never be reported as not made - the page would offer a retry
    // and make a second one.
    const { data: story, error: storyError } = await db
      .from('stories')
      .select('status')
      .eq('id', row.story_id)
      .eq('family_id', familyId)
      .maybeSingle()
    if (storyError) throw new Error(`generation_requests story read: ${storyError.message}`)
    const storyStatus = (story as { status: string } | null)?.status
    if (storyStatus === 'ready' || storyStatus === 'flagged') return { status: storyStatus, story_id: row.story_id }
  }
  const saved = row.status === 'ready' || row.status === 'flagged'
  const stale = row.status === 'writing' && now - Date.parse(row.started_at) > STALE_AFTER_MS
  return { status: stale ? 'failed' : row.status, story_id: saved ? row.story_id : null }
}
