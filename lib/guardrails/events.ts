import { createHash } from 'node:crypto'
import type { GuardrailEvent, GuardrailLayer, GuardrailCategory } from '@/lib/schemas/guardrail'

/**
 * `guardrail_events` logging - GUARDRAILS.md s1.5:
 * "Every refusal is logged (category, layer, hashed input) so the blocklists and the
 *  classifier can be improved from real traffic. Never log the raw text of refused
 *  inputs beyond 24 hours."
 *
 * The hash, layer and category are kept indefinitely; `raw_text` is nulled by
 * `purge_guardrail_raw_text()` (migration 20260927000004). The sink is injectable so
 * unit tests need no database.
 */

/** Stable, salt-free SHA-256 so the same input hashes alike across deploys (s1.5). */
export function hashInput(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC').trim().toLowerCase()).digest('hex')
}

export interface GuardrailEventSink {
  write(event: GuardrailEvent): Promise<void>
}

export class MemoryGuardrailSink implements GuardrailEventSink {
  readonly events: GuardrailEvent[] = []
  async write(event: GuardrailEvent): Promise<void> {
    this.events.push(event)
  }
  clear(): void {
    this.events.length = 0
  }
}

let sink: GuardrailEventSink = new MemoryGuardrailSink()

export function setGuardrailSink(next: GuardrailEventSink): void {
  sink = next
}
export function getGuardrailSink(): GuardrailEventSink {
  return sink
}

export interface LogGuardrailInput {
  layer: GuardrailLayer
  category: GuardrailCategory
  /** Raw parent text. Hashed for the permanent record; stored raw for at most 24h. */
  text: string
  field?: string | null
  familyId?: string | null
  /**
   * Whether to store the raw text at all. Default true: s1.5 wants it for tuning, and
   * the retention function removes it after 24h.
   */
  retainRawText?: boolean
}

export async function logGuardrailEvent(input: LogGuardrailInput): Promise<GuardrailEvent> {
  const event: GuardrailEvent = {
    layer: input.layer,
    category: input.category,
    input_hash: hashInput(input.text),
    field: input.field ?? null,
    family_id: input.familyId ?? null,
    raw_text: input.retainRawText === false ? null : input.text,
  }
  await sink.write(event)
  return event
}

/**
 * Supabase-backed sink. Service role: `guardrail_events` has RLS on and no policies, so
 * it is invisible to every authenticated client by design (migration 2).
 */
export function supabaseGuardrailSink(client: {
  from: (table: string) => {
    insert: (rows: unknown) => Promise<{ error: { message: string } | null }>
  }
}): GuardrailEventSink {
  return {
    async write(event: GuardrailEvent): Promise<void> {
      const { error } = await client.from('guardrail_events').insert(event)
      if (error) throw new Error(`guardrail_events insert failed: ${error.message}`)
    },
  }
}

let installedSupabase = false

/**
 * Point `logGuardrailEvent()` at `guardrail_events`. Called once from `instrumentation.ts`,
 * next to the cost-log sink; idempotent.
 *
 * The default sink is in memory, and until 2026-09-28 nothing installed this one: every
 * refusal in the running app was "audited" into process memory and lost, while the lane's
 * tests - which inject their own sink - stayed green.
 */
export async function installSupabaseGuardrailSink(): Promise<void> {
  if (installedSupabase) return
  const { supabaseService } = await import('@/lib/supabase/service')
  const db = supabaseService()
  setGuardrailSink(
    supabaseGuardrailSink({
      from: (table) => ({
        insert: async (rows) => {
          const { error } = await db.from(table).insert(rows as Record<string, unknown>)
          return { error }
        },
      }),
    }),
  )
  installedSupabase = true
}
