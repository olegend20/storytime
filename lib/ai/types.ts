import type { CallPurpose } from '@/lib/schemas/common'

/** A row in generation_logs. Written for EVERY attempt, success or failure (F8 AC). */
export interface GenerationLogRow {
  family_id: string | null
  story_id: string | null
  fact_pack_id: string | null
  purpose: CallPurpose
  model: string
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  cost_usd: number
  latency_ms: number
  ok: boolean
  error: string | null
}

/**
 * Where cost logs go. Injectable so unit tests need no database and so lane 3
 * (F8/F12) can swap in the Supabase-backed sink without touching call sites.
 */
export interface GenerationLogSink {
  write(row: GenerationLogRow): Promise<void>
}

/** Default sink: collects in memory. Replaced at runtime by the Supabase sink. */
export class MemoryLogSink implements GenerationLogSink {
  readonly rows: GenerationLogRow[] = []
  async write(row: GenerationLogRow): Promise<void> {
    this.rows.push(row)
  }
  get totalCostUsd(): number {
    return Math.round(this.rows.reduce((sum, r) => sum + r.cost_usd, 0) * 1e6) / 1e6
  }
  clear(): void {
    this.rows.length = 0
  }
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly detail: {
      purpose: CallPurpose
      model: string
      attempts: number
      retryable: boolean
      status?: number
      stopReason?: string | null
    },
  ) {
    super(message)
    this.name = 'ModelCallError'
  }
}

/**
 * Thrown when a model declines the request (stop_reason: "refusal").
 *
 * We deliberately do NOT enable server-side fallbacks to route around refusals:
 * in a children's product a refusal is signal we want to see and log, and silently
 * retrying on another model would undercut the guardrail design. See DECISIONS.md.
 */
export class ModelRefusalError extends Error {
  constructor(
    readonly model: string,
    readonly category: string | null,
    readonly explanation: string | null,
  ) {
    super(`Model ${model} declined the request${category ? ` (${category})` : ''}.`)
    this.name = 'ModelRefusalError'
  }
}

/**
 * Writes to several sinks. Exists because passing a `MemoryLogSink` to get a per-run total
 * REPLACES the installed Supabase sink, so the run's costs are counted in memory and never
 * persisted - which is how a fact-pack build reported its own cost while leaving
 * `generation_logs` empty. Tee instead of replace.
 */
export class TeeLogSink implements GenerationLogSink {
  constructor(private readonly sinks: readonly GenerationLogSink[]) {}
  async write(row: GenerationLogRow): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.write(row)
      } catch (err) {
        // One failing sink must not lose the row for the others, or silence the call.
        console.warn(
          `[costs] a log sink failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }
}
