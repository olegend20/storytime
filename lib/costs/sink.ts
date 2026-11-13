import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { setDefaultLogSink } from '@/lib/ai/callModel'
import type { GenerationLogRow, GenerationLogSink } from '@/lib/ai/types'
import { supabaseService } from '@/lib/supabase/service'

/**
 * F8: the Supabase-backed `GenerationLogSink`. `callModel()` already writes a row for every
 * attempt including failures and refusals; this is where those rows land.
 *
 * Service role, always: `generation_logs` has RLS on and NO policies at all, so clients see
 * nothing and only a role that bypasses RLS can write (§3).
 */
export class SupabaseLogSink implements GenerationLogSink {
  private readonly client?: SupabaseClient
  /** Last write failure, for the admin page and tests. Writes never throw — see below. */
  lastError: string | null = null
  failedWrites = 0

  constructor(client?: SupabaseClient) {
    this.client = client
  }

  /**
   * Log ids written for a story whose row did not exist yet, by story id (issue #104). The
   * pipeline inserts the story only when it is saved, so every call before that - the
   * writes, the gate, the rewrite - names a story the foreign key cannot see yet.
   */
  private readonly unlinked = new Map<string, string[]>()

  async write(row: GenerationLogRow): Promise<void> {
    const id = randomUUID()
    let refs: References = { family_id: row.family_id, story_id: row.story_id, fact_pack_id: row.fact_pack_id }
    let { error } = await this.insert(id, row, refs)
    while (error && (error.code === INVALID_TEXT_REPRESENTATION || error.code === FOREIGN_KEY_VIOLATION)) {
      /**
       * A reference that is not a UUID (the eval harness correlates by ids like
       * `eval:titanic-band-b`) or does not exist: the story not saved yet, or an eval family
       * cleaned up before its judge call was logged. The COST is the point of this table:
       * keep the row and drop references, the story first, then the pack, then the family,
       * so a story not saved yet still leaves the row on its family.
       */
      const next = dropOne(refs)
      if (!next) break
      console.warn(`[costs] generation_logs: ${error.message} - logging ${row.purpose}/${row.model} without its ${next.dropped} reference`)
      refs = next.refs
      ;({ error } = await this.insert(id, row, refs))
    }

    if (!error && refs.story_id === null && row.story_id !== null && UUID.test(row.story_id)) {
      if (!this.unlinked.has(row.story_id) && this.unlinked.size >= MAX_UNLINKED_STORIES) {
        // A discarded or failed story is never saved, so its entry is never claimed.
        this.unlinked.delete(this.unlinked.keys().next().value!)
      }
      this.unlinked.set(row.story_id, [...(this.unlinked.get(row.story_id) ?? []), id])
    }

    if (error) {
      /**
       * Deliberately swallowed. `callModel()` awaits this sink from inside its own catch
       * block, so a throw here would replace the real ModelCallError with a logging error
       * and lose the cause of the failure. A story that generated but was not logged is
       * strictly better than a story that failed because logging did. The miss is loud in
       * the server log and surfaced on /admin via `failedWrites`.
       */
      this.failedWrites += 1
      this.lastError = error.message
      console.error(
        `[costs] generation_logs insert failed (${row.purpose}/${row.model}, $${row.cost_usd}): ${error.message}`,
      )
    }
  }

  /** The story row exists now: point the rows written before it at it. Never throws. */
  async linkStory(storyId: string): Promise<void> {
    const ids = this.unlinked.get(storyId)
    if (!ids) return
    this.unlinked.delete(storyId)
    const db = this.client ?? supabaseService()
    const { error } = await db.from('generation_logs').update({ story_id: storyId }).in('id', ids)
    if (error) {
      this.failedWrites += 1
      this.lastError = error.message
      console.error(`[costs] linking ${ids.length} generation_logs rows to story ${storyId} failed: ${error.message}`)
    }
  }

  private insert(id: string, row: GenerationLogRow, refs: References) {
    const db = this.client ?? supabaseService()
    return db.from('generation_logs').insert({
      id,
      ...refs,
      purpose: row.purpose,
      model: row.model,
      input_tokens: row.input_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      output_tokens: row.output_tokens,
      cost_usd: row.cost_usd,
      latency_ms: row.latency_ms,
      ok: row.ok,
      error: row.error,
    })
  }
}

type References = Pick<GenerationLogRow, 'family_id' | 'story_id' | 'fact_pack_id'>

/** The next reference to give up, in the order that loses the least. */
function dropOne(refs: References): { refs: References; dropped: string } | null {
  if (refs.story_id !== null) return { refs: { ...refs, story_id: null }, dropped: 'story' }
  if (refs.fact_pack_id !== null) return { refs: { ...refs, fact_pack_id: null }, dropped: 'fact pack' }
  if (refs.family_id !== null) return { refs: { ...refs, family_id: null }, dropped: 'family' }
  return null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Stories waiting for their row at once, per server instance; far above any real load. */
const MAX_UNLINKED_STORIES = 200

/** Postgres SQLSTATEs for a malformed uuid and a dangling foreign key. */
const INVALID_TEXT_REPRESENTATION = '22P02'
const FOREIGN_KEY_VIOLATION = '23503'

/** On `globalThis` for the same reason as the default sink itself - see lib/ai/callModel.ts. */
const INSTALLED = Symbol.for('storytime.installedSupabaseLogSink')
type InstalledHolder = typeof globalThis & { [INSTALLED]?: SupabaseLogSink }

/**
 * Point every `callModel()`/`streamModel()` call at Supabase. Called once from
 * `instrumentation.ts` when the server boots; idempotent.
 */
export function installSupabaseLogSink(client?: SupabaseClient): SupabaseLogSink {
  const holder = globalThis as InstalledHolder
  if (!holder[INSTALLED]) {
    holder[INSTALLED] = new SupabaseLogSink(client)
    setDefaultLogSink(holder[INSTALLED])
  }
  return holder[INSTALLED]
}

export function installedLogSink(): SupabaseLogSink | null {
  return (globalThis as InstalledHolder)[INSTALLED] ?? null
}
