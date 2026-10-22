import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { callModel } from '@/lib/ai/callModel'
import { streamModel } from '@/lib/ai/streamModel'
import { closeKind, failedRowError, isTruncatedStream, newTrace, summarize } from '@/lib/ai/streamTrace'
import { MemoryLogSink, ModelCallError } from '@/lib/ai/types'
import { SupabaseLogSink } from '@/lib/costs/sink'
import { dropsLine, stepLatency } from '@/lib/eval/harness'
import { parseThinkingDisplay } from '@/lib/eval/pipeline'

/**
 * Issue #78: who closed the stream, and what came over the wire first. The wire tests run the
 * real SDK against a local server, as #50 and #76 do - the SDK rewraps undici's errors, and
 * only a real socket shows what a real cut looks like.
 */

type Mode = 'cut_thinking' | 'hold' | 'empty' | 'thinking_then_text'
let server: Server
let mode: Mode = 'cut_thinking'
let connections = 0
const bodies: Record<string, unknown>[] = []
const env = { ...process.env }

const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const start = (res: ServerResponse) =>
  send(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_cc', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [],
      stop_reason: null, usage: { input_tokens: 100, output_tokens: 3 },
    },
  })

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    connections += 1
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}') as Record<string, unknown>)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'request-id': `req_cc${connections}`,
        'x-understudy-request-id': `01a1-cc${connections}`,
      })
      if (mode === 'empty') {
        // A 200, then a clean end with no event (space-race-band-d, 2026-10-22).
        res.end()
        return
      }
      start(res)
      if (mode === 'hold') return // never ends: only our abort stops it
      if (mode === 'thinking_then_text') {
        send(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
        send(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a secret plan' } })
        send(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } })
        send(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        send(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
        send(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the story' } })
        send(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })
        send(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } })
        send(res, 'message_stop', { type: 'message_stop' })
        res.end()
        return
      }
      // cut_thinking: pings while the model "thinks" silently, a pause, then the socket dies.
      res.write('event: ping\ndata: {"type": "ping"}\n\n')
      setTimeout(() => res.write('event: ping\ndata: {"type": "ping"}\n\n'), 20)
      setTimeout(() => res.socket?.destroy(), 140)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-key'
  process.env.LIVE_API = '1'
  delete process.env.RECORD_FIXTURES
})

afterAll(async () => {
  process.env = env
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  connections = 0
  bodies.length = 0
})

const msgs = [{ role: 'user' as const, content: 'write' }]
const fails = <T,>(p: Promise<T>) => p.then(() => null, (e: unknown) => e)

describe('issue #78: who closed the stream, through the real SDK', () => {
  it('VT-SC1: a stream the far side cuts mid-thinking is logged peer_reset, with the bytes, the pings, the silence and the ids', async () => {
    mode = 'cut_thinking'
    const sink = new MemoryLogSink()
    const err = await fails(streamModel({ purpose: 'write', model: 'claude-sonnet-5', messages: msgs, sink }))
    expect(err).toBeInstanceOf(ModelCallError)
    expect((err as ModelCallError).detail).toMatchObject({ dropped: true, close: 'peer_reset' })
    const row = sink.rows[0]!
    expect(row.stream).toMatchObject({
      close: 'peer_reset',
      cause: 'UND_ERR_SOCKET:other side closed',
      events: { message_start: 1, ping: 2 },
      request_id: 'req_cc1',
      understudy_id: '01a1-cc1',
    })
    expect(row.stream!.bytes).toBeGreaterThan(0)
    // The ~120 ms of silence between the last ping and the cut is the longest gap.
    expect(row.stream!.max_gap_ms).toBeGreaterThanOrEqual(90)
    expect(row.error).toMatch(
      /^\[partial usage, lower bound\] terminated \[close=peer_reset cause=UND_ERR_SOCKET:other side closed t=\S+ hdr=\S+ bytes=\d+ events=message_start:1,ping:2 gap=\S+ last=\S+ req=req_cc1 us=01a1-cc1\]$/,
    )
  })

  it('VT-SC2: our own abort is own_abort, never peer - streamModel and callModel, signal and deadline', async () => {
    mode = 'hold'
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 60)
    const sink = new MemoryLogSink()
    const err = await fails(streamModel({ purpose: 'write', model: 'claude-sonnet-5', messages: msgs, sink, signal: ac.signal }))
    expect((err as ModelCallError).detail).toMatchObject({ close: 'own_abort' })
    expect((err as ModelCallError).detail.dropped).toBe(false)
    expect(sink.rows[0]!.error).toMatch(/\[close=own_abort /)

    // callModel's own deadline (timeoutMs) is ours too, and a long call's is not retried.
    const sink2 = new MemoryLogSink()
    const err2 = await fails(callModel({ purpose: 'rewrite', model: 'claude-sonnet-5', messages: msgs, sink: sink2, timeoutMs: 400_000, deadlineAt: Date.now() + 80 }))
    expect((err2 as ModelCallError).detail).toMatchObject({ close: 'own_abort' })
    expect(sink2.rows.every((r) => r.stream?.close === 'own_abort')).toBe(true)
  })

  it('VT-SC3: a 200 that ends with no message is a drop: streamModel says dropped, callModel retries it', async () => {
    mode = 'empty'
    const sink = new MemoryLogSink()
    const err = await fails(streamModel({ purpose: 'write', model: 'claude-sonnet-5', messages: msgs, sink }))
    expect((err as ModelCallError).detail).toMatchObject({ dropped: true, close: 'peer_end' })
    expect(sink.rows[0]!.stream).toMatchObject({ close: 'peer_end', bytes: 0, request_id: 'req_cc1' })

    connections = 0
    const sink2 = new MemoryLogSink()
    const err2 = await fails(callModel({ purpose: 'rewrite', model: 'claude-sonnet-5', messages: msgs, sink: sink2, maxRetries: 2 }))
    // One drop retried (maxDrops 1), then given up: two attempts, both logged peer_end.
    expect(connections).toBe(2)
    expect((err2 as ModelCallError).detail).toMatchObject({ dropped: true, close: 'peer_end' })
    expect(sink2.rows.map((r) => r.stream?.close)).toEqual(['peer_end', 'peer_end'])
  })

  it('VT-SC4: thinkingDisplay unset sends the same request as before; set, it asks for the summary, and no thinking reaches onText', async () => {
    mode = 'thinking_then_text'
    await streamModel({ purpose: 'write', model: 'claude-sonnet-5', messages: msgs, thinking: 'adaptive', sink: new MemoryLogSink() })
    await callModel({ purpose: 'rewrite', model: 'claude-sonnet-5', messages: msgs, thinking: 'adaptive', sink: new MemoryLogSink() })
    expect(bodies.map((b) => b.thinking)).toEqual([{ type: 'adaptive' }, { type: 'adaptive' }])

    bodies.length = 0
    const shown: string[] = []
    const out = await streamModel({
      purpose: 'write', model: 'claude-sonnet-5', messages: msgs, thinking: 'adaptive', thinkingDisplay: 'summarized',
      sink: new MemoryLogSink(), onText: (t) => shown.push(t),
    })
    await callModel({ purpose: 'rewrite', model: 'claude-sonnet-5', messages: msgs, thinking: 'adaptive', thinkingDisplay: 'summarized', sink: new MemoryLogSink() })
    expect(bodies.map((b) => b.thinking)).toEqual([
      { type: 'adaptive', display: 'summarized' },
      { type: 'adaptive', display: 'summarized' },
    ])
    expect(shown.join('')).toBe('the story')
    expect(out.text).toBe('the story')
  })

  it('VT-SC6: a successful call logs the same columns as before; the trace is in memory only and never stored', async () => {
    mode = 'thinking_then_text'
    const sink = new MemoryLogSink()
    await streamModel({ purpose: 'write', model: 'claude-sonnet-5', messages: msgs, sink })
    const row = sink.rows[0]!
    expect(row).toMatchObject({ ok: true, error: null, input_tokens: 100, output_tokens: 9 })
    expect(row.stream).toMatchObject({ close: null, request_id: 'req_cc1' })

    const inserted: Record<string, unknown>[] = []
    const db = { from: () => ({ insert: async (r: Record<string, unknown>) => (inserted.push(r), { error: null }) }) }
    await new SupabaseLogSink(db as never).write(row)
    expect(Object.keys(inserted[0]!)).not.toContain('stream')
    expect(inserted[0]).toMatchObject({ ok: true, error: null })
  })
})

describe('issue #78: the close kinds and the report', () => {
  const coded = (code: string, message = code) => Object.assign(new Error(message), { code })
  const terminated = (cause: Error) => Object.assign(new TypeError('terminated'), { cause })

  it('VT-SC1: each way a call can end has its own stable kind', () => {
    const t = newTrace()
    expect(closeKind(terminated(coded('UND_ERR_SOCKET', 'other side closed')), false, t)).toBe('peer_reset')
    expect(closeKind(terminated(coded('UND_ERR_BODY_TIMEOUT')), false, t)).toBe('local_timeout')
    expect(closeKind(new APIConnectionError({ cause: coded('ECONNREFUSED') }), false, t)).toBe('connect_failed')
    expect(closeKind(new APIError(undefined, { error: { type: 'upstream_response_error' } }, undefined, undefined, 'upstream_response_error' as never), false, t)).toBe('upstream_error')
    expect(closeKind(new APIError(529, {}, 'overloaded', undefined), false, t)).toBe('http_error')
    expect(closeKind(terminated(coded('UND_ERR_SOCKET')), true, t)).toBe('own_abort')
    expect(closeKind(new Error('who knows'), false, t)).toBe('unknown')
  })

  it('VT-SC3: only the SDK\'s no-message end counts as a truncated stream', async () => {
    const { AnthropicError } = await import('@anthropic-ai/sdk')
    expect(isTruncatedStream(new AnthropicError('stream ended without producing a Message with role=assistant'))).toBe(true)
    expect(isTruncatedStream(new AnthropicError('request ended without sending any chunks'))).toBe(true)
    expect(isTruncatedStream(new AnthropicError('something else'))).toBe(false)
    expect(isTruncatedStream(new Error('stream ended without producing a Message'))).toBe(false)
  })

  it('the suffix survives a long message: the row never loses its evidence to the 500-char cap', () => {
    const sum = summarize(newTrace(Date.now() - 1000), 'peer_reset', 'UND_ERR_SOCKET:other side closed')
    const err = failedRowError('x'.repeat(2000), sum)
    expect(err.length).toBeLessThanOrEqual(500)
    expect(err).toMatch(/\[close=peer_reset cause=UND_ERR_SOCKET:other side closed .*\]$/)
  })

  it('VT-SC5: the eval counts real drops apart from our own aborts, with the longest silence', () => {
    const row = (ok: boolean, close: string | null, gap: number, pings = 0) => ({
      family_id: null, story_id: null, fact_pack_id: null, purpose: 'write' as const, model: 'm',
      input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, cost_usd: 0, latency_ms: 1000, ok, error: null,
      stream: { close: close as never, cause: null, elapsed_ms: 60_000, headers_ms: 1, bytes: 1, events: { ping: pings }, max_gap_ms: gap, last_byte_ago_ms: 0, request_id: null, understudy_id: null },
    })
    const steps = stepLatency([row(true, null, 150_000, 3), row(false, 'peer_reset', 40_000), row(false, 'own_abort', 5_000)])
    expect(steps.write).toMatchObject({ calls: 3, failed: { peer_reset: 1, own_abort: 1 }, max_gap_ms: 150_000, pings: 3 })
    expect(dropsLine(steps)).toBe('  drops (issue #78): write 1/3 dropped (peer_reset 1), 1 own abort(s), longest silence 150.0s, 1.0 pings/min')
    // A run from before the trace (no stream on any row) prints no line.
    expect(dropsLine({ write: { calls: 1, ms: 1, output_tokens: 1 } })).toBeNull()
  })

  it('VT-SC4: the eval flag takes only "summarized", so a typo cannot quietly measure the default', () => {
    expect(parseThinkingDisplay(undefined)).toBeUndefined()
    expect(parseThinkingDisplay('summarized')).toBe('summarized')
    expect(() => parseThinkingDisplay('summarised')).toThrow(/expected "summarized"/)
    expect(() => parseThinkingDisplay('')).toThrow()
  })
})
