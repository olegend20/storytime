import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * How each accepted story request ended (issue #59): the `generation_requests` table.
 *
 * The page sends an id with the request (`x-generation-id`). If its stream drops, it asks
 * `GET /api/generations/{id}` instead of guessing from the library - a discarded story has no
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
  const { error } = await db.from('generation_requests').insert({ id, family_id: familyId })
  if (error) console.warn(`[generate] generation_requests start: ${error.message}`)
}

export async function finishGenerationRequest(
  db: SupabaseClient,
  id: string,
  outcome: { status: Exclude<GenerationRequestStatus, 'writing'>; storyId: string | null; reason?: string | null },
): Promise<void> {
  const { error } = await db
    .from('generation_requests')
    .update({
      status: outcome.status,
      story_id: outcome.storyId,
      reason: outcome.reason?.slice(0, 200) ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) console.warn(`[generate] generation_requests finish: ${error.message}`)
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
  const saved = row.status === 'ready' || row.status === 'flagged'
  const stale = row.status === 'writing' && now - Date.parse(row.started_at) > STALE_AFTER_MS
  return { status: stale ? 'failed' : row.status, story_id: saved ? row.story_id : null }
}
