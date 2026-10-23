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
  /**
   * What came over the wire on a live call (issue #78). In memory only - the eval reads it -
   * and never stored: the Supabase sink writes the columns above. A failed row's `error`
   * carries the same evidence as a suffix.
   */
  stream?: StreamSummary
}

/**
 * Who ended a failed call (issue #78). Stable values.
 * - `peer_reset`: the other side closed the socket (undici `other side closed`, ECONNRESET).
 * - `peer_end`: the stream ended cleanly before its message did.
 * - `upstream_error`: the upstream sent `event: error` partway.
 * - `connect_failed`: no response at all.
 * - `local_timeout`: undici's own body or headers timeout.
 * - `own_abort`: our signal - the deadline, a parent leaving, the forced-drop eval, a wrong-model abort.
 * - `http_error`: an HTTP status we were sent.
 */
export type CloseKind =
  | 'peer_reset'
  | 'peer_end'
  | 'upstream_error'
  | 'connect_failed'
  | 'local_timeout'
  | 'own_abort'
  | 'http_error'
  | 'unknown'

export interface StreamSummary {
  /** Null when the call completed. */
  close: CloseKind | null
  /** The deepest coded cause, `CODE:message`. */
  cause: string | null
  elapsed_ms: number
  headers_ms: number | null
  bytes: number
  /** SSE events by name, pings included. */
  events: Record<string, number>
  /** The longest silence between chunks; for a failed call, to the close too. */
  max_gap_ms: number
  last_byte_ago_ms: number | null
  request_id: string | null
  understudy_id: string | null
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
      /**
       * The connection was cut partway through a stream (undici `terminated`, a reset socket) or
       * failed outright (the SDK's `Connection error.`).
       * `streamModel` never retries itself; the caller decides whether it safely can (#52).
       */
      dropped?: boolean
      /** The gateway answered with another model than the one requested (#76); never used. */
      servedBy?: string
      /** Who ended the call (#78). */
      close?: CloseKind
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
