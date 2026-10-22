import { AnthropicError, APIError } from '@anthropic-ai/sdk'
import type { Middleware } from '@anthropic-ai/sdk/core/middleware'
import type { CloseKind, StreamSummary } from './types'

/**
 * What came over the wire for one live call, and who ended it (issue #78). Understudy saw our
 * cut streams as "client disconnected"; we saw undici's `terminated`. Neither side had logged
 * which end closed the socket, nor whether any byte flowed while Sonnet 5 thought with its
 * thinking hidden (`display: "omitted"`, its default). The SDK drops `ping` events before our
 * code sees them, so the trace reads the raw body: bytes, SSE events by name (pings included),
 * the longest silence, and the ids that match a row to the gateway's capture.
 *
 * Read-only: the middleware passes the request through untouched and the body through byte for
 * byte. It is one of the wrappers' request options, so CLAUDE.md rule 1 holds.
 */
export interface StreamTrace {
  startedAt: number
  headersAt: number | null
  lastByteAt: number | null
  bytes: number
  events: Record<string, number>
  maxGapMs: number
  requestId: string | null
  understudyId: string | null
}

export function newTrace(now = Date.now()): StreamTrace {
  return { startedAt: now, headersAt: null, lastByteAt: null, bytes: 0, events: {}, maxGapMs: 0, requestId: null, understudyId: null }
}

/** A gateway id header, whatever its exact name: `x-understudy-request-id` or the like. */
function understudyId(headers: Headers): string | null {
  for (const [name, value] of headers) {
    if (name.startsWith('x-understudy-') && /(request|trace)-?id$/.test(name)) return value
  }
  return null
}

export function traceMiddleware(trace: StreamTrace): Middleware {
  return async (request, next) => {
    const response = await next(request)
    trace.headersAt = Date.now()
    trace.requestId = response.headers.get('request-id')
    trace.understudyId = understudyId(response.headers)
    if (!response.body) return response
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let carry = ''
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (err) {
          controller.error(err)
          return
        }
        if (chunk.done) {
          controller.close()
          return
        }
        const now = Date.now()
        trace.maxGapMs = Math.max(trace.maxGapMs, now - (trace.lastByteAt ?? trace.headersAt ?? now))
        trace.lastByteAt = now
        trace.bytes += chunk.value.byteLength
        // Count `event: <name>` lines; a line split across two chunks is carried over.
        const lines = (carry + decoder.decode(chunk.value, { stream: true })).split('\n')
        carry = lines.pop() ?? ''
        for (const line of lines) {
          const m = /^event:\s*(\S+)/.exec(line)
          if (m) trace.events[m[1]!] = (trace.events[m[1]!] ?? 0) + 1
        }
        controller.enqueue(chunk.value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
      // Read only when the SDK reads: no chunk is fetched ahead, so an abort on `connect` (#76)
      // still lands before the first event is parsed.
    }, { highWaterMark: 0 })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

/**
 * The stream ended cleanly before its message did: no `message_stop`, so the SDK has no Message.
 * On 2026-10-22 a write got a 200 with headers in 1.3 s, then nothing, then a clean end 42 s
 * later. Not a request we got wrong, so it is a drop like `terminated`, and written again.
 */
export function isTruncatedStream(err: unknown): boolean {
  return (
    err instanceof AnthropicError &&
    !(err instanceof APIError) &&
    /^(stream ended without producing a Message|request ended without sending any chunks)/.test(err.message)
  )
}

const PEER_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'])
const CONNECT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
const TIMEOUT_CODES = new Set(['UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])
const UPSTREAM_TYPES = new Set(['upstream_response_error', 'overloaded_error', 'api_error'])

/** The deepest cause with a code, as `CODE:message` - `UND_ERR_SOCKET:other side closed`. */
export function causeOf(err: unknown): string | null {
  let found: string | null = null
  let e: unknown = err
  for (let depth = 0; depth < 6 && typeof e === 'object' && e !== null; depth += 1) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string') found = `${code}:${(e as { message?: unknown }).message ?? ''}`
    e = (e as { cause?: unknown }).cause
  }
  return found
}

/**
 * Who ended a failed call. `ownAbort` is the caller's: our signal fired (the request deadline,
 * a parent leaving, the forced-drop eval, the wrong-model abort). Stable values: tests and the
 * eval's `drops:` line assert on them, not on prose.
 */
export function closeKind(err: unknown, ownAbort: boolean, trace: StreamTrace): CloseKind {
  if (ownAbort) return 'own_abort'
  if (isTruncatedStream(err)) return 'peer_end'
  if (err instanceof APIError && err.status === undefined && UPSTREAM_TYPES.has(String(err.type))) return 'upstream_error'
  const codes: string[] = []
  let e: unknown = err
  for (let depth = 0; depth < 6 && typeof e === 'object' && e !== null; depth += 1) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code)
    e = (e as { cause?: unknown }).cause
  }
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return 'local_timeout'
  if (codes.some((c) => PEER_CODES.has(c))) return 'peer_reset'
  if (trace.headersAt === null && codes.some((c) => CONNECT_CODES.has(c))) return 'connect_failed'
  if (err instanceof APIError && typeof err.status === 'number') return 'http_error'
  return 'unknown'
}

export function summarize(trace: StreamTrace, close: CloseKind | null, cause: string | null, now = Date.now()): StreamSummary {
  return {
    close,
    cause,
    elapsed_ms: now - trace.startedAt,
    headers_ms: trace.headersAt === null ? null : trace.headersAt - trace.startedAt,
    bytes: trace.bytes,
    events: { ...trace.events },
    max_gap_ms: trace.lastByteAt === null ? 0 : Math.max(trace.maxGapMs, close ? now - trace.lastByteAt : 0),
    last_byte_ago_ms: trace.lastByteAt === null ? null : now - trace.lastByteAt,
    request_id: trace.requestId,
    understudy_id: trace.understudyId,
  }
}

const s = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`)

/**
 * The compact suffix a failed row's error text carries, so the evidence survives in
 * `generation_logs` with no new column:
 * `[close=peer_reset cause=UND_ERR_SOCKET:other side closed t=152.8s hdr=1.3s bytes=48211 events=ping:9 gap=31.0s last=0.4s req=req_… us=…]`
 */
export function closeSuffix(sum: StreamSummary): string {
  const events = Object.entries(sum.events).map(([k, v]) => `${k}:${v}`).join(',') || 'none'
  return (
    `[close=${sum.close ?? 'none'}` +
    (sum.cause ? ` cause=${sum.cause.slice(0, 60)}` : '') +
    ` t=${s(sum.elapsed_ms)} hdr=${s(sum.headers_ms)} bytes=${sum.bytes} events=${events.slice(0, 120)}` +
    ` gap=${s(sum.max_gap_ms)} last=${s(sum.last_byte_ago_ms)}` +
    (sum.request_id ? ` req=${sum.request_id}` : '') +
    (sum.understudy_id ? ` us=${sum.understudy_id}` : '') +
    ']'
  )
}

/** A failed row's error text: the message, then the suffix, never cut off by the 500-char column cap. */
export function failedRowError(message: string, sum: StreamSummary): string {
  const suffix = closeSuffix(sum)
  return `${message.slice(0, Math.max(40, 499 - suffix.length))} ${suffix}`.slice(0, 500)
}
