import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CallPurpose } from '@/lib/schemas/common'
import { callModel } from '@/lib/ai/callModel'
import { streamModel } from '@/lib/ai/streamModel'
import { MemoryLogSink, ModelCallError } from '@/lib/ai/types'
import {
  CONTINUATION_WORKLOAD,
  WORKLOADS,
  servedByOtherModel,
  understudyHeaders,
  viaUnderstudy,
  workloadFor,
} from '@/lib/ai/workload'
import { missingWorkloads } from '@/scripts/understudy-workloads'

/**
 * Issue #76: every model call is tagged with its own Understudy workload. The wire tests run
 * the real SDK against a local server that records the request headers and answers as the
 * gateway does, `x-understudy-effective-model` included.
 */

const env = { ...process.env }
afterEach(() => {
  process.env = { ...env }
})

describe('issue #76: the workload map', () => {
  it('VT-UW1: each CallPurpose and the continuation has its own workload, none of them main', () => {
    const names = CallPurpose.options.map((p) => workloadFor(p))
    expect(new Set(names).size).toBe(CallPurpose.options.length)
    expect(workloadFor('write', { continuation: true })).toBe(CONTINUATION_WORKLOAD)
    // Only a write can be a continuation.
    expect(workloadFor('rewrite', { continuation: true })).toBe('rewrite')
    expect(WORKLOADS).toHaveLength(CallPurpose.options.length + 1)
    expect(new Set(WORKLOADS).size).toBe(WORKLOADS.length)
    expect(WORKLOADS).not.toContain('main')
    for (const w of WORKLOADS) expect(w).toMatch(/^[a-z]+(-[a-z]+)*$/)
  })

  it('VT-UW3: the headers go only to the Understudy gateway', () => {
    delete process.env.UNDERSTUDY_HEADERS
    expect(viaUnderstudy(undefined)).toBe(false)
    expect(viaUnderstudy('https://api.anthropic.com')).toBe(false)
    expect(viaUnderstudy('https://understudylabs.com.example.org')).toBe(false)
    expect(viaUnderstudy('not a url')).toBe(false)
    expect(viaUnderstudy('https://api.understudylabs.com')).toBe(true)

    delete process.env.ANTHROPIC_BASE_URL
    expect(understudyHeaders('write')).toEqual({})
    process.env.ANTHROPIC_BASE_URL = 'https://api.understudylabs.com'
    delete process.env.UNDERSTUDY_PROJECT
    expect(understudyHeaders('quality')).toEqual({ 'x-understudy-project': 'rehearsal', 'x-understudy-workload': 'quality' })
    process.env.UNDERSTUDY_PROJECT = 'storytime'
    expect(understudyHeaders('quality')['x-understudy-project']).toBe('storytime')
  })

  it('VT-UW4: a reply from another model is caught; a supplier prefix is not another model', () => {
    const h = (v?: string) => new Headers(v ? { 'x-understudy-effective-model': v } : {})
    expect(servedByOtherModel('claude-sonnet-5', h())).toBeNull()
    expect(servedByOtherModel('claude-sonnet-5', null)).toBeNull()
    expect(servedByOtherModel('claude-sonnet-5', h('claude-sonnet-5'))).toBeNull()
    expect(servedByOtherModel('claude-sonnet-5', h('azure/claude-sonnet-5'))).toBeNull()
    expect(servedByOtherModel('claude-sonnet-5', h('gemma-4-12b'))).toBe('gemma-4-12b')
    expect(servedByOtherModel('claude-sonnet-5', h('claude-sonnet-5-mini'))).toBe('claude-sonnet-5-mini')
  })

  it('VT-UW5: the registration script creates exactly the workloads the code sends', () => {
    expect(missingWorkloads([])).toEqual([...WORKLOADS])
    expect(missingWorkloads([...WORKLOADS, 'main'])).toEqual([])
  })
})

describe('issue #76: the headers on the wire, through the real SDK', () => {
  let server: Server
  const seen: IncomingHttpHeaders[] = []
  let effective: string | null = null

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers)
      req.resume()
      const headers: Record<string, string> = { 'content-type': 'text/event-stream' }
      if (effective) headers['x-understudy-effective-model'] = effective
      res.writeHead(200, headers)
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_tag', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [],
          stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 },
        },
      })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })
      send('message_stop', { type: 'message_stop' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const live = (tag: boolean) => {
    const { port } = server.address() as { port: number }
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-key'
    process.env.LIVE_API = '1'
    delete process.env.RECORD_FIXTURES
    delete process.env.UNDERSTUDY_PROJECT
    if (tag) process.env.UNDERSTUDY_HEADERS = '1'
    else delete process.env.UNDERSTUDY_HEADERS
    seen.length = 0
    effective = null
  }
  const ask = (sink = new MemoryLogSink()) =>
    callModel({ purpose: 'classify_input', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], sink })
  const stream = (continuation = false, sink = new MemoryLogSink()) =>
    streamModel({
      purpose: 'write', model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], sink,
      ...(continuation ? { continuation } : {}),
    })

  it('VT-UW2: callModel and streamModel send the project and the workload; the continuation is its own', async () => {
    live(true)
    await ask()
    await stream()
    await stream(true)
    expect(seen.map((h) => [h['x-understudy-project'], h['x-understudy-workload']])).toEqual([
      ['rehearsal', 'classify-input'],
      ['rehearsal', 'write'],
      ['rehearsal', 'write-continue'],
    ])
  })

  it('VT-UW3: not on the gateway, no x-understudy header is sent', async () => {
    live(false)
    await ask()
    await stream()
    expect(seen).toHaveLength(2)
    for (const h of seen) expect(Object.keys(h).filter((k) => k.startsWith('x-understudy'))).toEqual([])
  })

  it('VT-UW4: a reply from another model is logged as failed and never returned', async () => {
    live(true)
    effective = 'gemma-4-12b'
    for (const call of [ask, (sink: MemoryLogSink) => stream(false, sink)]) {
      const sink = new MemoryLogSink()
      const err = await call(sink).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(ModelCallError)
      expect((err as ModelCallError).detail).toMatchObject({ servedBy: 'gemma-4-12b', retryable: false })
      // One row, with the usage that was billed, not a second one from the error path.
      expect(sink.rows).toHaveLength(1)
      expect(sink.rows[0]).toMatchObject({ ok: false, error: 'served_by_other_model:gemma-4-12b', output_tokens: 2 })
    }
    // Not retried: one request each.
    expect(seen).toHaveLength(2)

    effective = 'azure/claude-sonnet-5'
    await expect(ask()).resolves.toMatchObject({ text: 'ok' })
  })
})
