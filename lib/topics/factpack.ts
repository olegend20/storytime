import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import type { GenerationLogSink } from '@/lib/ai'
import { FactPack, type FactPackRecord, type FactSource } from '@/lib/schemas'
import { buildFactPack, sourcesOf } from './build'
import { reviewFactPack, trimFactPackToBudget } from './review'

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
/**
 * A `rejected` row older than this is rebuilt by the next request (issue #28). Before: a
 * topic whose first pack failed the review was dead for every family, forever. Now a
 * rejection costs the topic a day, and a topic costs at most one build a day.
 */
export const REJECTED_RETRY_AFTER_MS = 24 * 60 * 60_000

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
  /** Test seam for the rejection window: the `updated_at` trigger cannot be aged. */
  now?: () => number
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
  now: () => number = Date.now,
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
  if (existing.status === 'rejected' && rejectionExpired(existing, now)) {
    // Issue #28: an old rejection is rebuilt. The compare-and-swap on `status` means two
    // simultaneous requests still produce one build: the loser sees `building` and waits.
    // Matching the timestamp this caller saw closes the gap where a fresh rejection, written
    // between the read and this update, would be taken over as if it were the old one.
    let takeover = db
      .from('fact_packs')
      .update({ status: 'building', model: 'pending', topic_label: topicLabel })
      .eq('id', existing.id)
      .eq('status', 'rejected')
    if (existing.updated_at) takeover = takeover.eq('updated_at', existing.updated_at)
    const { data: retaken, error: takeoverError } = await takeover.select('id').maybeSingle()
    if (takeoverError) throw new Error(`fact_packs takeover: ${takeoverError.message}`)
    return retaken ? String((retaken as { id: string }).id) : null
  }
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
    // An expired rejection is about to be taken over by whoever won the claim (issue #28):
    // it is not an answer, so keep waiting for the row it becomes.
    if (row && row.status !== 'building' && !(row.status === 'rejected' && rejectionExpired(row, opts.now))) {
      return row
    }
    if (Date.now() >= deadline) throw new FactPackTimeoutError(topicKey)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/** Issue #28: a rejection older than REJECTED_RETRY_AFTER_MS no longer stands. */
function rejectionExpired(row: RawRow, now: () => number = Date.now): boolean {
  const at = row.updated_at ? Date.parse(row.updated_at) : Number.NaN
  return Number.isFinite(at) && now() - at > REJECTED_RETRY_AFTER_MS
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
  if (existing && existing.status === 'rejected' && !rejectionExpired(existing, opts.now)) {
    return finish(existing, false)
  }

  const ownedId = await claimBuild(topicKey, topicLabel, db, opts.now)
  if (!ownedId) {
    // Another request is building. Wait for it rather than paying for a second build.
    return finish(await waitForBuild(topicKey, db, opts), false)
  }

  try {
    const attempt = async (forceResearch: boolean) => {
      const build = await (opts.builder ?? buildFactPack)(topicKey, topicLabel, {
        factPackId: ownedId,
        ...(forceResearch ? { forceResearch } : {}),
        ...(opts.sink ? { sink: opts.sink } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      const { candidate } = trimFactPackToBudget(build.candidate)
      const { deterministic, model } = await (opts.reviewer ?? reviewFactPack)(candidate, {
        factPackId: ownedId,
        ...(opts.sink ? { sink: opts.sink } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      const accepted = deterministic.accept && !!deterministic.pack && model.accept
      // A deterministic rejection skips the model and echoes its reasons into `model`.
      const reasons = accepted ? [] : [...new Set([...deterministic.reasons, ...model.reasons])]
      return { build, deterministic, model, accepted, reasons }
    }

    let result = await attempt(false)
    // Issue #28: a pack written from knowledge that the review turned down gets the path
    // with sources before the topic is given up on. One more build, never a loop.
    if (!result.accepted && result.build.mode === 'knowledge') {
      console.info(
        `[factpack] "${topicKey}": knowledge pack rejected (${result.reasons.join('; ')}) - researching`,
      )
      const second = await attempt(true)
      result = second.accepted
        ? second
        : { ...second, reasons: [...new Set([...result.reasons, ...second.reasons])] }
    }
    const { build, deterministic, model, reasons } = result

    if (!result.accepted || !deterministic.pack) {
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

/**
 * Topic keys with a `ready` pack, for cost estimates: a built pack is shared, so a run that
 * uses it pays nothing to research it. Empty (never throws) when the database is unreachable,
 * which makes the estimate err high rather than low.
 */
export async function readyFactPackTopics(
  db: SupabaseClient = supabaseService(),
): Promise<Set<string>> {
  try {
    const { data, error } = await db.from('fact_packs').select('topic_key').eq('status', 'ready')
    if (error) return new Set()
    return new Set((data ?? []).map((r) => r.topic_key as string))
  } catch {
    return new Set()
  }
}
