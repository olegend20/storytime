import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import type { z } from 'zod'
import type { CallPurpose } from '@/lib/schemas/common'
import { capabilities, computeCost, modelForRole } from './pricing'
import {
  MissingFixtureError,
  fixtureKey,
  readFixture,
  writeFixture,
  type FixturePayload,
} from './fixtures'
import {
  MemoryLogSink,
  ModelCallError,
  ModelRefusalError,
  type GenerationLogSink,
  type GenerationLogRow,
} from './types'

/**
 * THE single entry point for every model call in StoryTime (kickoff rule 1).
 * No direct SDK calls anywhere else - handles logging, cost, retries, caching
 * and fixture record/replay in one place so cost per story is knowable.
 */

export type { GenerationLogSink, GenerationLogRow }

export interface CacheableBlock {
  text: string
  /** Mark the last stable block with a breakpoint. s4.1: the master prompt is cached. */
  cache?: boolean
  cacheTtl?: '5m' | '1h'
}

export interface CallModelOptions<T = string> {
  purpose: CallPurpose
  /** A role from config/models.json ('writer' | 'helper' | ...) or an explicit model id. */
  role?: string
  model?: string
  /** System blocks in order. Stable content first; only stable blocks get `cache: true`. */
  system?: CacheableBlock[]
  messages: Anthropic.MessageParam[]
  maxTokens?: number
  tools?: Anthropic.ToolUnion[]
  /** Passed through untyped so a lane can opt into structured outputs. */
  outputConfig?: Record<string, unknown>
  /** 'adaptive' where supported; silently dropped on models that reject it. */
  thinking?: 'adaptive' | 'off'
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Validate and return typed JSON. Repair is the caller's job (s4.4). */
  schema?: z.ZodType<T>
  maxRetries?: number
  /**
   * Per-call HTTP timeout in ms. The SDK default is 10 minutes, which a long server-tool loop
   * can exceed - the fact-pack builder runs web search and timed out three times in a row,
   * burning 902s. Set generously for tool-loop calls. Bounds the whole streamed call, not
   * just the wait for headers (see DEFAULT_TIMEOUT_MS for the bound when unset).
   */
  timeoutMs?: number
  /**
   * The moment (epoch ms) the caller must have its answer by - a request's own deadline, less
   * what it needs afterwards. Every attempt's deadline is capped at it, so no attempt runs past
   * it, and no retry starts with less than `minRetryMs` left (issue #50).
   */
  deadlineAt?: number
  minRetryMs?: number
  /**
   * How many dropped streams are retried (default 1; issue #72). Each retry of a long call is a
   * whole new call, and the gateway bills the dropped one in full, so only a caller with
   * nothing to fall back on - or a deadline that bounds it - asks for more. Never more
   * attempts than `maxRetries` allows.
   */
  maxDrops?: number
  /** Log correlation. */
  familyId?: string | null
  storyId?: string | null
  factPackId?: string | null
  sink?: GenerationLogSink
  signal?: AbortSignal
}

export interface CallModelResult<T = string> {
  /** Concatenated text content. */
  text: string
  /** Present only when `schema` was supplied and validation passed. */
  data: T | null
  usage: {
    input_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    output_tokens: number
    web_searches: number
  }
  costUsd: number
  latencyMs: number
  model: string
  stopReason: string | null
  /** True when served from a recorded fixture rather than the API. */
  replayed: boolean
  raw: unknown
}

const DEFAULT_MAX_TOKENS = 16_000
const DEFAULT_MAX_RETRIES = 2

/**
 * The process-wide default sink lives on `globalThis`, not in a module variable.
 *
 * Next.js loads `instrumentation.ts` in a different module graph from the route handlers, so
 * each has its own copy of this file. With a module variable, the boot hook pointed ITS copy
 * at Supabase while every route kept logging to memory: the running app never wrote one
 * `generation_logs` row, `/admin` saw nothing, and the daily budget cap could never trip.
 * `Symbol.for` gives every copy the same key.
 */
const DEFAULT_SINK = Symbol.for('storytime.defaultLogSink')
type SinkHolder = typeof globalThis & { [DEFAULT_SINK]?: GenerationLogSink }

/** Lane 3 (F8) calls this once at startup to point logs at Supabase. */
export function setDefaultLogSink(sink: GenerationLogSink): void {
  ;(globalThis as SinkHolder)[DEFAULT_SINK] = sink
}
export function getDefaultLogSink(): GenerationLogSink {
  const holder = globalThis as SinkHolder
  return (holder[DEFAULT_SINK] ??= new MemoryLogSink())
}

/**
 * Counts a run's rows (a `MemoryLogSink`) AND forwards each one to the default sink, which a
 * CLI has pointed at `generation_logs`. Passing a plain `MemoryLogSink` as `sink` REPLACES
 * the default, so the run's spend is counted locally and never persisted - the leak that hid
 * the eval, bake-off and reliability CLIs from /admin.
 */
export class MeteredLogSink extends MemoryLogSink {
  private readonly forward: GenerationLogSink
  constructor(forward: GenerationLogSink = getDefaultLogSink()) {
    super()
    this.forward = forward
  }
  override async write(row: GenerationLogRow): Promise<void> {
    await super.write(row)
    try {
      await this.forward.write(row)
    } catch (err) {
      console.warn(`[costs] forwarding a log row failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

let client: Anthropic | null = null
function anthropic(): Anthropic {
  if (!client) {
    // We run our own retry loop so every attempt gets its own generation_logs row.
    client = new Anthropic({ maxRetries: 0 })
  }
  return client
}

/**
 * The whole-call deadline when `timeoutMs` is unset: the SDK's own default, which bounded a
 * non-streaming call end to end before every call streamed.
 */
const DEFAULT_TIMEOUT_MS = 600_000

/**
 * A call that asks for more than this is a long call: when it hits its own deadline it is not
 * retried. Five minutes, undici's `headersTimeout`, the line that used to decide streaming.
 */
const LONG_CALL_MS = 300_000

function isLive(): boolean {
  return process.env.LIVE_API === '1' || process.env.LIVE_API === 'true'
}
function isRecording(): boolean {
  return process.env.RECORD_FIXTURES === '1' || process.env.RECORD_FIXTURES === 'true'
}

/** Build system blocks with cache_control on the ones marked stable. */
function buildSystem(blocks: CacheableBlock[] | undefined): Anthropic.TextBlockParam[] | undefined {
  if (!blocks || blocks.length === 0) return undefined
  return blocks.map((b) => {
    const block: Anthropic.TextBlockParam = { type: 'text', text: b.text }
    if (b.cache) {
      // Cast: cache_control is on the wire type but narrow in some SDK minors.
      ;(block as unknown as Record<string, unknown>).cache_control = {
        type: 'ephemeral',
        ...(b.cacheTtl === '1h' ? { ttl: '1h' } : {}),
      }
    }
    return block
  })
}

/**
 * Apply per-model capability rules from config/models.json rather than assuming a
 * uniform API. Haiku 4.5 rejects `effort`; Fable 5.1 rejects any explicit thinking
 * config; none of the current writers accept `temperature`.
 */
function applyCapabilities(
  model: string,
  opts: { thinking?: 'adaptive' | 'off'; effort?: string },
): { thinking?: Record<string, unknown>; output_config?: Record<string, unknown> } {
  const caps = capabilities(model)
  const out: { thinking?: Record<string, unknown>; output_config?: Record<string, unknown> } = {}

  const thinkingMode = caps.thinking as string | undefined
  if (opts.thinking === 'adaptive') {
    // Fable 5.1 has thinking always on and 400s on any explicit config: omit entirely.
    if (thinkingMode !== 'always_on_omit_param' && thinkingMode !== 'extended_budget_tokens') {
      out.thinking = { type: 'adaptive' }
    }
  }
  // Haiku 5.5 thinks unless told not to, so "off" has to be said. Every other model stays as it
  // was: omitting the parameter is already "off" for them, or they reject "disabled".
  if (opts.thinking === 'off' && thinkingMode === 'adaptive_default_on') {
    out.thinking = { type: 'disabled' }
  }

  if (opts.effort && caps.supports_effort === true) {
    out.output_config = { effort: opts.effort }
  }

  return out
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => {
      const block = b as { type?: string; text?: unknown }
      return block.type === 'text' && typeof block.text === 'string'
    })
    .map((b) => b.text)
    .join('')
}

export function normalizeUsage(usage: unknown): CallModelResult['usage'] {
  const u = (usage ?? {}) as Record<string, unknown>
  const serverToolUse = (u.server_tool_use ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return {
    input_tokens: num(u.input_tokens),
    cache_read_tokens: num(u.cache_read_input_tokens),
    cache_write_tokens: num(u.cache_creation_input_tokens),
    output_tokens: num(u.output_tokens),
    web_searches: num(serverToolUse.web_search_requests),
  }
}

/**
 * True when the API refused a structured-output request itself (a model without support, a
 * schema it will not compile) - never for billing, rate limits or transport. A caller can
 * then retry without the format rather than not run at all.
 */
export function structuredOutputRejected(err: unknown): boolean {
  return (
    err instanceof ModelCallError &&
    err.detail.status === 400 &&
    /output_config|output format|json_schema|schema|structured/i.test(err.message)
  )
}

/**
 * A stream that was cut off partway: undici's `TypeError('terminated')` (its cause a socket
 * "other side closed"), or a reset socket. The SDK's MessageStream rewraps any non-SDK error
 * as a plain `AnthropicError` with the original as `cause` (SDK 0.128 MessageStream.js), so
 * the socket code is two levels down - the cause chain is walked, not just the top error.
 * Not an `APIConnectionError`, so before issue #50 it was never retried: 2 of ~10 rewrites
 * through the gateway died this way on 2026-10-14.
 */
export function isDroppedStream(err: unknown): boolean {
  if (err instanceof APIError) return false
  let e: unknown = err
  for (let depth = 0; depth < 4 && typeof e === 'object' && e !== null; depth += 1) {
    if (e instanceof Error && e.name === 'TypeError' && e.message === 'terminated') return true
    const code = (e as { code?: unknown }).code
    if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET') return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** Retry on transport failures and the transient HTTP statuses; never on a 4xx we caused. */
function isRetryable(err: unknown): { retryable: boolean; status?: number } {
  if (err instanceof APIConnectionError) return { retryable: true }
  if (isDroppedStream(err)) return { retryable: true }
  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined
    if (status === undefined) return { retryable: true }
    return { retryable: status === 408 || status === 409 || status === 429 || status >= 500, status }
  }
  return { retryable: false }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Error('aborted'))
      },
      { once: true },
    )
  })
}

export async function callModel<T = string>(
  opts: CallModelOptions<T>,
): Promise<CallModelResult<T>> {
  const model = opts.model ?? modelForRole(opts.role ?? 'helper')
  const sink = opts.sink ?? getDefaultLogSink()
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES

  const system = buildSystem(opts.system)
  const capExtras = applyCapabilities(model, {
    thinking: opts.thinking,
    effort: opts.effort,
  })
  const outputConfig = { ...(capExtras.output_config ?? {}), ...(opts.outputConfig ?? {}) }

  const request: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: opts.messages,
    ...(system ? { system } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(capExtras.thinking ? { thinking: capExtras.thinking } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  }

  const key = fixtureKey({
    model,
    system,
    messages: opts.messages,
    tools: opts.tools,
    max_tokens: maxTokens,
    output_config: Object.keys(outputConfig).length > 0 ? outputConfig : undefined,
    thinking: capExtras.thinking,
  })

  // ---- Replay path: the default in tests. Never touches the network. ----
  if (!isLive()) {
    const fixture = readFixture(opts.purpose, key)
    if (!fixture) throw new MissingFixtureError(opts.purpose, key, model)
    return finish({
      opts,
      model,
      sink,
      usage: { ...fixture.usage, web_searches: fixture.usage.web_searches ?? 0 },
      text: extractText((fixture.response as { content?: unknown })?.content),
      stopReason: fixture.stop_reason,
      raw: fixture.response,
      latencyMs: 0,
      replayed: true,
    })
  }

  // ---- Live path, with per-attempt logging. ----
  // A dropped stream is retried `maxDrops` times at most: each retry of a long call is a whole new call.
  const maxDrops = opts.maxDrops ?? 1
  let drops = 0
  const timeLeft = () => (opts.deadlineAt === undefined ? Number.POSITIVE_INFINITY : opts.deadlineAt - Date.now())
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const started = Date.now()
    let stream: ReturnType<Anthropic['messages']['stream']> | null = null
    let deadline: AbortSignal | null = null
    // This attempt's budget: `timeoutMs`, capped at what is left before `deadlineAt`.
    const attemptMs = Math.max(1, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, timeLeft()))
    try {
      const reqOpts = { signal: opts.signal, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) }
      const params = request as unknown as Anthropic.MessageCreateParamsNonStreaming
      // Every call streams (issue #41). A non-streaming response sends nothing until it is
      // complete, and two things cut that silence short: Node's fetch (undici) gives up on
      // headers after 300s - every fact-pack build once died at exactly 300.0s - and the
      // Understudy gateway closes a response with no first byte after ~125s. Streaming sends
      // headers at once; finalMessage() is the same Message, usage included, so the request,
      // the tokens and the cost are unchanged.
      //
      // But the SDK's `timeout` only bounds the wait for headers, so a stream has no total
      // limit: one fact-pack build ran 50 minutes before the connection dropped. `deadline`
      // enforces `timeoutMs` over the whole call, or the SDK's own ten minutes when unset.
      deadline = AbortSignal.timeout(attemptMs)
      const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
      stream = anthropic().messages.stream(params, { ...reqOpts, signal })
      const response = (await stream.finalMessage()) as unknown as Record<string, unknown>

      const latencyMs = Date.now() - started
      const usage = normalizeUsage(response.usage)
      const stopReason = (response.stop_reason as string | null) ?? null

      // A refusal is a successful HTTP call with a declined result. Log it, then raise.
      if (stopReason === 'refusal') {
        const details = (response.stop_details ?? {}) as Record<string, unknown>
        await logRow(sink, opts, model, usage, latencyMs, false, `refusal:${details.category ?? 'unknown'}`)
        throw new ModelRefusalError(
          model,
          (details.category as string | null) ?? null,
          (details.explanation as string | null) ?? null,
        )
      }

      if (isRecording()) {
        const payload: FixturePayload = {
          purpose: opts.purpose,
          model,
          response,
          usage: {
            input_tokens: usage.input_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            cache_write_tokens: usage.cache_write_tokens,
            output_tokens: usage.output_tokens,
            ...(usage.web_searches ? { web_searches: usage.web_searches } : {}),
          },
          stop_reason: stopReason,
          recorded_at: new Date().toISOString(),
        }
        writeFixture(opts.purpose, key, payload)
      }

      return finish({
        opts,
        model,
        sink,
        usage,
        text: extractText(response.content),
        stopReason,
        raw: response,
        latencyMs,
        replayed: false,
      })
    } catch (err) {
      if (err instanceof ModelRefusalError) throw err
      // Hitting our own deadline on a call that ASKED for more than five minutes is not
      // retried: a second full-length attempt doubles the cost of a call that has already run
      // long. Any other call that times out is retried, as it was before every call streamed
      // (the SDK's timeout was retryable) - the fact-pack builders count on their one retry.
      const timedOut = deadline?.aborted === true && opts.signal?.aborted !== true
      const budgetMs = attemptMs
      const { retryable: retryableKind, status } = timedOut
        ? { retryable: (opts.timeoutMs ?? 0) <= LONG_CALL_MS, status: undefined }
        : isRetryable(err)
      const dropped = !timedOut && isDroppedStream(err)
      if (dropped) drops += 1
      // A caller that gave up (the parent closed the page) is never retried: before issue #50
      // its abort read as a status-less APIError, and so as a transport failure worth retrying.
      const retryable =
        retryableKind &&
        opts.signal?.aborted !== true &&
        !(dropped && drops > maxDrops) &&
        timeLeft() >= (opts.deadlineAt === undefined ? 0 : (opts.minRetryMs ?? 0))
      const latencyMs = Date.now() - started
      const message = timedOut
        ? `deadline: exceeded timeoutMs=${budgetMs}`
        : err instanceof Error
          ? err.message
          : String(err)

      // F8 AC: every call gets a log row, including failures. A stream that dies partway has
      // already consumed tokens: log what it reported so far, a LOWER BOUND on what was billed
      // (the final usage totals only arrive at the end), rather than $0.
      const partial = stream?.currentMessage?.usage
      await logRow(
        sink,
        opts,
        model,
        partial
          ? normalizeUsage(partial)
          : { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, web_searches: 0 },
        latencyMs,
        false,
        `${partial ? '[partial usage, lower bound] ' : ''}${message}`.slice(0, 500),
      )

      if (!retryable || attempt === maxRetries + 1) {
        throw new ModelCallError(
          `${opts.purpose} call to ${model} failed after ${attempt} attempt(s): ${message}`,
          { purpose: opts.purpose, model, attempts: attempt, retryable, status, ...(dropped ? { dropped: true } : {}) },
        )
      }
      await sleep(Math.min(2 ** attempt * 250, 4000), opts.signal)
    }
  }

  throw new ModelCallError(`${opts.purpose} call to ${model} exhausted retries`, {
    purpose: opts.purpose,
    model,
    attempts: maxRetries + 1,
    retryable: true,
  })
}

async function logRow<T>(
  sink: GenerationLogSink,
  opts: CallModelOptions<T>,
  model: string,
  usage: CallModelResult['usage'],
  latencyMs: number,
  ok: boolean,
  error: string | null,
): Promise<void> {
  await sink.write({
    family_id: opts.familyId ?? null,
    story_id: opts.storyId ?? null,
    fact_pack_id: opts.factPackId ?? null,
    purpose: opts.purpose,
    model,
    input_tokens: usage.input_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    output_tokens: usage.output_tokens,
    cost_usd: computeCost({
      model,
      input: usage.input_tokens,
      cacheRead: usage.cache_read_tokens,
      cacheWrite: usage.cache_write_tokens,
      output: usage.output_tokens,
      webSearches: usage.web_searches,
    }),
    latency_ms: latencyMs,
    ok,
    error,
  })
}

async function finish<T>(args: {
  opts: CallModelOptions<T>
  model: string
  sink: GenerationLogSink
  usage: CallModelResult['usage']
  text: string
  stopReason: string | null
  raw: unknown
  latencyMs: number
  replayed: boolean
}): Promise<CallModelResult<T>> {
  const { opts, model, sink, usage, text, stopReason, raw, latencyMs, replayed } = args

  const costUsd = computeCost({
    model,
    input: usage.input_tokens,
    cacheRead: usage.cache_read_tokens,
    cacheWrite: usage.cache_write_tokens,
    output: usage.output_tokens,
    webSearches: usage.web_searches,
  })

  await logRow(sink, opts, model, usage, latencyMs, true, null)

  let data: T | null = null
  if (opts.schema) {
    const parsed = opts.schema.safeParse(parseJsonLoose(text))
    if (parsed.success) data = parsed.data
  }

  return { text, data, usage, costUsd, latencyMs, model, stopReason, replayed, raw }
}

/**
 * Tolerant JSON extraction: strips ```json fences and finds the outermost object.
 * Returns undefined on failure so the caller can run the s4.4 repair pass.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  for (const candidate of [unfenced, trimmed]) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* try the next shape */
    }
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        /* fall through */
      }
    }
  }
  return undefined
}
