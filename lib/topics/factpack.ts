import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import type { GenerationLogSink } from '@/lib/ai'
import { FactPack, type FactPackRecord, type FactSource } from '@/lib/schemas'
import { buildFactPack, sourcesOf } from './build'
import { reviewFactPack } from './review'

/**
 * `getOrBuildFactPack` (F5). One pack per topic, shared by every family, built at most
 * once even under concurrent requests.
 *
 * The lock is the `fact_packs` row itself: `topic_key` is unique, so the first writer to
 * insert a `status='building'` row owns the build and everyone else waits on it. That
 * needs no extra table and survives a process restart (a stale `building` row is taken
 * over after BUILD_LOCK_STALE_MS).
 */

export const BUILD_POLL_INTERVAL_MS = 250
export const BUILD_POLL_TIMEOUT_MS = 180_000
/** A `building` row older than this is assumed abandoned and may be taken over. */
export const BUILD_LOCK_STALE_MS = 10 * 60_000

const PACK_COLUMNS =
  'id, topic_key, topic_label, content, sources, model, version, use_count, quality_score, status, updated_at'

export class FactPackRejectedError extends Error {
  constructor(
    readonly topicKey: string,
    readonly reasons: string[],
  ) {
    super(`Fact pack for "${topicKey}" was rejected: ${reasons.join('; ')}`)
    this.name = 'FactPackRejectedError'
  }
}

export class FactPackTimeoutError extends Error {
  constructor(readonly topicKey: string) {
    super(`Timed out waiting for another request to finish building the "${topicKey}" fact pack`)
    this.name = 'FactPackTimeoutError'
  }
}

interface RawRow extends Omit<FactPackRecord, 'content' | 'sources'> {
  content: unknown
  sources: unknown
  updated_at?: string
}

export interface GetOrBuildOptions {
  db?: SupabaseClient
  sink?: GenerationLogSink
  signal?: AbortSignal
  /** Count this fetch as a use (default true). F5 AC: use_count tracks stories, not reads. */
  countUse?: boolean
  pollIntervalMs?: number
  pollTimeoutMs?: number
  /**
   * Seams for testing the LOCK rather than the model. The F5 concurrency VT is about
   * "built at most once under concurrent requests", and injecting a counted builder proves
   * that directly instead of inferring it from log rows. Production leaves both unset.
   */
  builder?: typeof buildFactPack
  reviewer?: typeof reviewFactPack
}

export interface GetOrBuildResult {
  record: FactPackRecord
  /** True when this call performed the build (and therefore the only web searches). */
  built: boolean
}

async function readRow(
  topicKey: string,
  db: SupabaseClient,
): Promise<RawRow | null> {
  const { data, error } = await db
    .from('fact_packs')
    .select(PACK_COLUMNS)
    .eq('topic_key', topicKey)
    .maybeSingle()
  if (error) throw new Error(`fact_packs read: ${error.message}`)
  return (data as RawRow | null) ?? null
}

function toRecord(row: RawRow): FactPackRecord {
  const parsed = FactPack.safeParse(row.content)
  if (!parsed.success) {
    throw new Error(
      `fact_packs.content for "${row.topic_key}" does not match FactPack: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
  }
  return {
    id: row.id,
    topic_key: row.topic_key,
    topic_label: row.topic_label,
    content: parsed.data,
    sources: (Array.isArray(row.sources) ? row.sources : []) as FactSource[],
    model: row.model,
    version: Number(row.version ?? 1),
    use_count: Number(row.use_count ?? 0),
    quality_score: row.quality_score === null ? null : Number(row.quality_score),
    status: row.status,
  }
}

/**
 * Claim the build. Returns the row id when this caller owns it, null when someone else
 * already does. The insert races on the unique `topic_key`, which is what makes the lock
 * correct without a transaction.
 */
async function claimBuild(
  topicKey: string,
  topicLabel: string,
  db: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await db
    .from('fact_packs')
    .insert({
      topic_key: topicKey,
      topic_label: topicLabel,
      content: {},
      sources: [],
      model: 'pending',
      status: 'building',
    })
    .select('id')
    .maybeSingle()

  if (!error && data) return String((data as { id: string }).id)

  // Lost the race, or a previous attempt left a stale lock we can take over.
  const existing = await readRow(topicKey, db)
  if (!existing) throw new Error(`claimBuild: ${error?.message ?? 'insert returned no row'}`)
  if (existing.status !== 'building') return null

  const updatedAt = existing.updated_at ? Date.parse(existing.updated_at) : Date.now()
  if (Number.isFinite(updatedAt) && Date.now() - updatedAt > BUILD_LOCK_STALE_MS) {
    const { data: taken } = await db
      .from('fact_packs')
      .update({ model: 'pending' })
      .eq('id', existing.id)
      .eq('status', 'building')
      .select('id')
      .maybeSingle()
    if (taken) return String((taken as { id: string }).id)
  }
  return null
}

async function waitForBuild(
  topicKey: string,
  db: SupabaseClient,
  opts: GetOrBuildOptions,
): Promise<RawRow> {
  const interval = opts.pollIntervalMs ?? BUILD_POLL_INTERVAL_MS
  const timeout = opts.pollTimeoutMs ?? BUILD_POLL_TIMEOUT_MS
  const deadline = Date.now() + timeout

  for (;;) {
    const row = await readRow(topicKey, db)
    if (row && row.status !== 'building') return row
    if (Date.now() >= deadline) throw new FactPackTimeoutError(topicKey)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/**
 * Increment `use_count`.
 *
 * A popular topic is fetched concurrently at bedtime, so this has to be atomic: a
 * read-modify-write loop measurably loses increments (8 concurrent callers landed 5), and
 * `use_count` feeds the §5 cache-hit-rate target and the F12 admin views. The atomic path is
 * the `increment_fact_pack_use` SQL function (migration 20260927002001).
 *
 * The compare-and-swap loop remains as a fallback for a database that has not applied that
 * migration yet - other lanes share this database and their branches may lag - so a missing
 * function degrades the counter's accuracy under load rather than breaking generation.
 */
export async function incrementFactPackUse(
  id: string,
  db: SupabaseClient = supabaseService(),
  attempts = 8,
): Promise<number | null> {
  const { data: rpcData, error: rpcError } = await db.rpc('increment_fact_pack_use', {
    p_id: id,
  })
  if (!rpcError && typeof rpcData === 'number') return rpcData

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { data: current, error: readError } = await db
      .from('fact_packs')
      .select('use_count')
      .eq('id', id)
      .maybeSingle()
    if (readError || !current) return null
    const from = Number((current as { use_count: number }).use_count ?? 0)

    const { data, error } = await db
      .from('fact_packs')
      .update({ use_count: from + 1 })
      .eq('id', id)
      .eq('use_count', from)
      .select('use_count')
      .maybeSingle()
    if (!error && data) return Number((data as { use_count: number }).use_count)
    // Jittered backoff: without it, contending callers retry in lockstep and keep colliding.
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40))
  }
  return null
}

/**
 * The pack for this topic. Builds it on a miss (the only web searches in the product),
 * reuses it on a hit, and makes concurrent callers share one build.
 */
export async function getOrBuildFactPack(
  topicKey: string,
  topicLabel: string,
  opts: GetOrBuildOptions = {},
): Promise<GetOrBuildResult> {
  const db = opts.db ?? supabaseService()
  const countUse = opts.countUse !== false

  const finish = async (row: RawRow, built: boolean): Promise<GetOrBuildResult> => {
    if (row.status === 'rejected') {
      const reasons = Array.isArray((row.content as { review_reasons?: unknown })?.review_reasons)
        ? ((row.content as { review_reasons: string[] }).review_reasons ?? [])
        : ['previously rejected']
      throw new FactPackRejectedError(topicKey, reasons)
    }
    const record = toRecord(row)
    if (countUse) {
      const next = await incrementFactPackUse(record.id, db)
      if (next !== null) record.use_count = next
    }
    return { record, built }
  }

  const existing = await readRow(topicKey, db)
  if (existing && existing.status === 'ready') return finish(existing, false)
  if (existing && existing.status === 'rejected') return finish(existing, false)

  const ownedId = await claimBuild(topicKey, topicLabel, db)
  if (!ownedId) {
    // Another request is building. Wait for it rather than paying for a second build.
    return finish(await waitForBuild(topicKey, db, opts), false)
  }

  try {
    const build = await (opts.builder ?? buildFactPack)(topicKey, topicLabel, {
      factPackId: ownedId,
      ...(opts.sink ? { sink: opts.sink } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    const { deterministic, model } = await (opts.reviewer ?? reviewFactPack)(build.candidate, {
      factPackId: ownedId,
      ...(opts.sink ? { sink: opts.sink } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })

    if (!deterministic.accept || !deterministic.pack || !model.accept) {
      const reasons = [...deterministic.reasons, ...model.reasons]
      await db
        .from('fact_packs')
        .update({
          content: { review_reasons: reasons },
          model: build.model,
          status: 'rejected',
          quality_score: model.quality_score,
        })
        .eq('id', ownedId)
      throw new FactPackRejectedError(topicKey, reasons)
    }

    const { data, error } = await db
      .from('fact_packs')
      .update({
        topic_label: deterministic.pack.topic_label,
        content: deterministic.pack,
        sources: sourcesOf(deterministic.pack),
        model: build.model,
        status: 'ready',
        quality_score: model.quality_score,
      })
      .eq('id', ownedId)
      .select(PACK_COLUMNS)
      .maybeSingle()
    if (error || !data) throw new Error(`fact_packs write: ${error?.message ?? 'no row'}`)

    return finish(data as RawRow, true)
  } catch (err) {
    if (err instanceof FactPackRejectedError) throw err
    // Release the lock so the next request can retry rather than poll a dead build.
    await db.from('fact_packs').delete().eq('id', ownedId).eq('status', 'building')
    throw err
  }
}

/** Read-only lookup, for the suggested-topics endpoint and the admin views. */
export async function findFactPack(
  topicKey: string,
  db: SupabaseClient = supabaseService(),
): Promise<FactPackRecord | null> {
  const row = await readRow(topicKey, db)
  if (!row || row.status !== 'ready') return null
  return toRecord(row)
}
