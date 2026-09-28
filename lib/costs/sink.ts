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

  async write(row: GenerationLogRow): Promise<void> {
    const db = this.client ?? supabaseService()
    const { error } = await db.from('generation_logs').insert({
      family_id: row.family_id,
      story_id: row.story_id,
      fact_pack_id: row.fact_pack_id,
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
}

let installed: SupabaseLogSink | null = null

/**
 * Point every `callModel()`/`streamModel()` call at Supabase. Called once from
 * `instrumentation.ts` when the server boots; idempotent.
 */
export function installSupabaseLogSink(client?: SupabaseClient): SupabaseLogSink {
  if (!installed) {
    installed = new SupabaseLogSink(client)
    setDefaultLogSink(installed)
  }
  return installed
}

export function installedLogSink(): SupabaseLogSink | null {
  return installed
}
