import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { callModel } from '@/lib/ai/callModel'
import { streamModel } from '@/lib/ai/streamModel'
import { MemoryLogSink, ModelCallError } from '@/lib/ai/types'

/**
 * Issue #50, VT-R6: the real SDK against a local server that starts a stream and then cuts the
 * connection - the way the gateway did on 2026-10-14. No mock: the first version of this fix
 * passed its stubbed tests and missed every real drop, because the SDK's MessageStream rewraps
 * undici's `TypeError('terminated')` as an `AnthropicError` (`/code-review` on #51).
 */

let server: Server
let connections = 0
let mode: 'drop' | 'error500' | 'refuse' | 'upstream' | 'invalid' = 'drop'
const env = { ...process.env }

beforeAll(async () => {
  server = createServer((req, res) => {
    connections += 1
    req.resume()
    if (mode === 'refuse') {
      req.socket.destroy()
      return
    }
    if (mode === 'error500') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const start = {
      type: 'message_start',
      message: {
        id: 'msg_drop', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [],
        stop_reason: null, usage: { input_tokens: 100, output_tokens: 7 },
      },
    }
    res.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`)
    if (mode === 'upstream' || mode === 'invalid') {
      // The gateway's way of losing the upstream partway (2026-10-21): an error event, then the end.
      const type = mode === 'upstream' ? 'upstream_response_error' : 'invalid_request_error'
      res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message: 'upstream' } })}\n\n`)
      return
    }
    setTimeout(() => res.socket?.destroy(), 30)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-key'
  process.env.LIVE_API = '1'
})

afterAll(async () => {
  process.env = env
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('issue #50: a real dropped stream, through the real SDK', () => {
  it('VT-R6 is retried exactly once, and both attempts are logged with their partial usage', async () => {
    connections = 0
    const sink = new MemoryLogSink()
    const err = await callModel({
      purpose: 'rewrite',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'rewrite' }],
      timeoutMs: 600_000,
      maxRetries: 2,
      sink,
    }).then(
      () => null,
      (e: Error) => e,
    )
    expect(connections).toBe(2)
    expect(err?.message).toMatch(/rewrite call to claude-sonnet-5 failed after 2 attempt\(s\): terminated/)
    // Each row says who closed it (#78): the server destroyed the socket, so `peer_reset`.
    for (const r of sink.rows) {
      expect(r.error).toMatch(/^\[partial usage, lower bound\] terminated \[close=peer_reset cause=UND_ERR_SOCKET:other side closed /)
    }
    expect(sink.rows).toHaveLength(2)
  })

  it('VT-W1 (#52): streamModel reports a real drop or a lost connection as dropped, and a 500 as not', async () => {
    const write = () =>
      streamModel({ purpose: 'write', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'write' }], sink: new MemoryLogSink() }).then(
        () => null,
        (e: unknown) => e,
      )
    mode = 'drop'
    connections = 0
    const dropSink = new MemoryLogSink()
    const dropped = await streamModel({ purpose: 'write', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'write' }], sink: dropSink }).then(
      () => null,
      (e: unknown) => e,
    )
    // The cut attempt is logged with the usage seen before the cut, not $0 (reviewer agent, #56).
    expect(dropSink.rows).toHaveLength(1)
    expect(dropSink.rows[0]).toMatchObject({ ok: false, input_tokens: 100, output_tokens: 7 })
    expect(dropSink.rows[0]!.cost_usd).toBeGreaterThan(0)
    expect(dropSink.rows[0]!.error).toMatch(/^\[partial usage, lower bound\] /)
    expect(dropped).toBeInstanceOf(ModelCallError)
    expect((dropped as ModelCallError).detail).toMatchObject({ dropped: true, retryable: false })
    // streamModel itself never retries: the pipeline decides.
    expect(connections).toBe(1)

    mode = 'refuse'
    connections = 0
    const refused = await write()
    expect(refused).toBeInstanceOf(ModelCallError)
    expect((refused as ModelCallError).message).toMatch(/Connection error/)
    expect((refused as ModelCallError).detail).toMatchObject({ dropped: true, retryable: false })
    expect(connections).toBe(1)

    mode = 'error500'
    const failed = await write()
    expect(failed).toBeInstanceOf(ModelCallError)
    expect((failed as ModelCallError).detail).toMatchObject({ dropped: false, status: 500 })
    mode = 'drop'
  })

  it('VT-RS11 (#74): an upstream error event partway through counts as a drop; a request error does not', async () => {
    const write = () =>
      streamModel({ purpose: 'write', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'write' }], sink: new MemoryLogSink() }).then(
        () => null,
        (e: unknown) => e,
      )
    mode = 'upstream'
    connections = 0
    const lost = await write()
    expect(lost).toBeInstanceOf(ModelCallError)
    expect((lost as ModelCallError).message).toMatch(/upstream_response_error/)
    expect((lost as ModelCallError).detail).toMatchObject({ dropped: true, retryable: false })
    expect(connections).toBe(1)

    mode = 'invalid'
    const wrong = await write()
    expect(wrong).toBeInstanceOf(ModelCallError)
    expect((wrong as ModelCallError).detail).toMatchObject({ dropped: false })
    mode = 'drop'
  })
})
