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
/**
 * A waiter gives up after this. Since issue #28 a build can be two builds and two reviews in
 * a row (knowledge, research), so this sits just under the route's 300 s `maxDuration`.
 */
export const BUILD_POLL_TIMEOUT_MS = 270_000
/** A `building` row older than this is assumed abandoned and may be taken over. */
export const BUILD_LOCK_STALE_MS = 10 * 60_000
/**
 * How long a rejection stands before the next request rebuilds the topic (issue #28), by
 * how many times it has been rejected: a day after the first, a week after the second, and
 * after the third the topic is given up on. Before: one rejection was forever, for every
 * family. Now a topic that is really unwritable costs at most three builds, ever.
 */
export const REJECTION_WINDOWS_MS: readonly number[] = [24 * 60 * 60_000, 7 * 24 * 60 * 60_000]

/** What a `rejected` row keeps in `content`. */
interface RejectionRecord {
  review_reasons: string[]
  /** How many builds have been rejected, this one included. Absent on rows from before #28 (= 1). */
  rejections: number
}

function hasRejectionRecord(row: RawRow): boolean {
  const c = row.content as Partial<RejectionRecord> | null | undefined
  return row.status === 'rejected' || (!!c && Number.isInteger(c.rejections) && (c.rejections as number) > 0)
}

function rejectionOf(row: RawRow): RejectionRecord {
  const c = (row.content ?? {}) as Partial<RejectionRecord>
  return {
    review_reasons: Array.isArray(c.review_reasons) ? c.review_reasons : ['previously rejected'],
    rejections: Number.isInteger(c.rejections) && (c.rejections as number) > 0 ? (c.rejections as number) : 1,
  }
}

/** Age of a row by its `updated_at`; NaN when unknown. One computation for every window. */
function rowAgeMs(row: RawRow): number {
  return row.updated_at ? Date.now() - Date.parse(row.updated_at) : Number.NaN
}

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

/** The request that owned the build threw and released the lock; a retry may succeed. */
export class FactPackBuildFailedError extends Error {
  constructor(readonly topicKey: string) {
    super(`The "${topicKey}" fact pack build failed in another request; try again`)
    this.name = 'FactPackBuildFailedError'
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
  /**
   * Test seam: the rejection windows, in ms (default REJECTION_WINDOWS_MS). The
   * `updated_at` trigger cannot be aged from a test, so a test shortens the windows instead.
   */
  rejectionWindowsMs?: readonly number[]
  /** Test seam: when a `building` row counts as abandoned (default BUILD_LOCK_STALE_MS). */
  staleLockMs?: number
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
 * correct without a transaction. An expired rejection (issue #28) is taken over instead,
 * with a compare-and-swap on `status` and the `updated_at` this caller read, so a fresh
 * rejection written in between is never mistaken for the old one.
 */
async function claimBuild(
  topicKey: string,
  topicLabel: string,
  db: SupabaseClient,
  existing: RawRow | null,
  windows: readonly number[],
  staleLockMs: number,
): Promise<string | null> {
  if (existing && existing.status === 'rejected' && rejectionExpired(existing, windows)) {
    let takeover = db
      .from('fact_packs')
      .update({
        status: 'building',
        model: 'pending',
        topic_label: topicLabel,
        // Carry the old rejection forward (count and reasons): if this build throws, the row
        // goes back to being that rejection rather than a fresh start at zero strikes.
        content: rejectionOf(existing) satisfies RejectionRecord,
        quality_score: null,
      })
      .eq('id', existing.id)
      .eq('status', 'rejected')
    if (existing.updated_at) takeover = takeover.eq('updated_at', existing.updated_at)
    const { data: retaken, error: takeoverError } = await takeover.select('id').maybeSingle()
    if (takeoverError) throw new Error(`fact_packs takeover: ${takeoverError.message}`)
    return retaken ? String((retaken as { id: string }).id) : null
  }

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
  const current = await readRow(topicKey, db)
  if (!current) throw new Error(`claimBuild: ${error?.message ?? 'insert returned no row'}`)
  if (current.status !== 'building') return null

  if (rowAgeMs(current) > staleLockMs) {
    const { data: taken } = await db
      .from('fact_packs')
      .update({ model: 'pending' })
      .eq('id', current.id)
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

  const windows = opts.rejectionWindowsMs ?? REJECTION_WINDOWS_MS
  for (;;) {
    const row = await readRow(topicKey, db)
    // The builder deletes its row when the build itself throws. Nothing is coming: say so now
    // rather than after the full timeout, so the parent can try again.
    if (!row) throw new FactPackBuildFailedError(topicKey)
    // An expired rejection is about to be taken over by whoever won the claim (issue #28):
    // it is not an answer, so keep waiting for the row it becomes.
    if (row.status !== 'building' && !(row.status === 'rejected' && rejectionExpired(row, windows))) {
      return row
    }
    if (Date.now() >= deadline) throw new FactPackTimeoutError(topicKey)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/**
 * Issue #28: whether a rejection has stood for its window. The window grows with the count
 * (REJECTION_WINDOWS_MS); past the last one the rejection is final.
 */
function rejectionExpired(row: RawRow, windows: readonly number[]): boolean {
  const { rejections } = rejectionOf(row)
  const window = windows[rejections - 1]
  if (window === undefined) return false
  const age = rowAgeMs(row)
  return Number.isFinite(age) && age > window
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

  const windows = opts.rejectionWindowsMs ?? REJECTION_WINDOWS_MS

  const finish = async (row: RawRow, built: boolean): Promise<GetOrBuildResult> => {
    if (row.status === 'rejected') throw new FactPackRejectedError(topicKey, rejectionOf(row).review_reasons)
    const record = toRecord(row)
    if (countUse) {
      const next = await incrementFactPackUse(record.id, db)
      if (next !== null) record.use_count = next
    }
    return { record, built }
  }

  const existing = await readRow(topicKey, db)
  if (existing && existing.status === 'ready') return finish(existing, false)
  if (existing && existing.status === 'rejected' && !rejectionExpired(existing, windows)) {
    return finish(existing, false)
  }
  // The strikes so far. A `building` row can carry them too: a takeover build that was
  // killed rather than thrown (the 300 s route limit) leaves the record in `content`, and
  // the stale-lock path must not restart the topic at zero.
  const prior = existing && hasRejectionRecord(existing) ? rejectionOf(existing) : null
  const priorRejections = prior?.rejections ?? 0

  const ownedId = await claimBuild(topicKey, topicLabel, db, existing, windows, opts.staleLockMs ?? BUILD_LOCK_STALE_MS)
  if (!ownedId) {
    // Another request is building. Wait for it rather than paying for a second build.
    return finish(await waitForBuild(topicKey, db, opts), false)
  }

  const reject = async (reasons: string[], model: string, qualityScore: number | null) => {
    await db
      .from('fact_packs')
      .update({
        content: { review_reasons: reasons, rejections: priorRejections + 1 } satisfies RejectionRecord,
        model,
        status: 'rejected',
        quality_score: qualityScore,
      })
      .eq('id', ownedId)
    throw new FactPackRejectedError(topicKey, reasons)
  }

  try {
    const common = {
      factPackId: ownedId,
      ...(opts.sink ? { sink: opts.sink } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }
    const attempt = async (forceResearch: boolean) => {
      const build = await (opts.builder ?? buildFactPack)(topicKey, topicLabel, {
        ...common,
        ...(forceResearch ? { forceResearch } : {}),
      })
      const { candidate } = trimFactPackToBudget(build.candidate)
      const { deterministic, model } = await (opts.reviewer ?? reviewFactPack)(candidate, common)
      const accepted = deterministic.accept && !!deterministic.pack && model.accept
      // A deterministic rejection skips the model and echoes its reasons into `model`.
      const reasons = accepted ? [] : [...new Set([...deterministic.reasons, ...model.reasons])]
      return { build, deterministic, model, accepted, reasons }
    }

    let result = await attempt(false)
    // Issue #28: a pack written from knowledge that the review turned down gets the path
    // with sources before the topic is given up on. One more build, never a loop. If that
    // second build cannot run at all (a search outage), the first rejection is still
    // recorded - the topic is parked for its window, not rebuilt on every request.
    if (!result.accepted && result.build.mode === 'knowledge') {
      console.info(
        `[factpack] "${topicKey}": knowledge pack rejected (${result.reasons.join('; ')}) - researching`,
      )
      let second: typeof result
      try {
        second = await attempt(true)
      } catch (err) {
        // A parent closing the tab is not a strike against the topic: release and rethrow.
        if (opts.signal?.aborted) throw err
        const why = err instanceof Error ? err.message : String(err)
        await reject([...result.reasons, `research failed: ${why.slice(0, 200)}`], result.build.model, result.model.quality_score)
        throw err // unreachable: reject() throws
      }
      result = second.accepted
        ? second
        : { ...second, reasons: [...new Set([...result.reasons, ...second.reasons])] }
    }
    const { build, deterministic, model, reasons } = result

    if (!result.accepted || !deterministic.pack) await reject(reasons, build.model, model.quality_score)
    if (!deterministic.pack) throw new Error('unreachable: rejected packs throw above')

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
    if (prior) {
      // A takeover build that failed (a 529, a timeout, an abort) puts the old rejection
      // back, strikes and all: deleting the row would restart the topic at zero and let a
      // transient error keep an unwritable topic alive forever (DECISIONS #173).
      await db
        .from('fact_packs')
        .update({ status: 'rejected', content: prior satisfies RejectionRecord })
        .eq('id', ownedId)
        .eq('status', 'building')
      throw err
    }
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
