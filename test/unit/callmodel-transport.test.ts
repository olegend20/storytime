import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A call allowed to run past five minutes must stream.
 *
 * Node's fetch (undici) abandons a response whose headers take more than 300s, and a
 * non-streaming response sends no headers until it is finished. Every fact-pack build lost its
 * first attempt at exactly 300.0s to this while `timeoutMs` said 600s. The SDK is stubbed so
 * the live path runs without the network.
 */

const calls = vi.hoisted(() => ({ create: 0, stream: 0, hang: false }))

const message = {
  id: 'msg_stub',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 200_000,
    output_tokens: 10_000,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    server_tool_use: { web_search_requests: 5 },
  },
}

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
  class StubAnthropic {
    messages = {
      create: async () => {
        calls.create += 1
        return message
      },
      stream: (_params: unknown, opts: { signal?: AbortSignal }) => {
        calls.stream += 1
        if (!calls.hang) return { finalMessage: async () => message, currentMessage: message }
        // A stream that has started (message_start carried usage) and then never finishes.
        return {
          currentMessage: { ...message, usage: { ...message.usage, output_tokens: 700 } },
          finalMessage: () =>
            new Promise((_, reject) =>
              opts.signal?.addEventListener('abort', () => reject(new actual.APIUserAbortError())),
            ),
        }
      },
    }
  }
  return { ...actual, default: StubAnthropic }
})

const { callModel } = await import('@/lib/ai/callModel')
const { MemoryLogSink } = await import('@/lib/ai/types')
type Sink = InstanceType<typeof MemoryLogSink>
type CallModelResult = Awaited<ReturnType<typeof callModel>>

const saved = process.env.LIVE_API

afterEach(() => {
  vi.restoreAllMocks()
  calls.create = 0
  calls.stream = 0
  calls.hang = false
  if (saved === undefined) delete process.env.LIVE_API
  else process.env.LIVE_API = saved
})

const run = (timeoutMs?: number, maxRetries?: number) => {
  process.env.LIVE_API = '1'
  const sink = new MemoryLogSink()
  return callModel({
    purpose: 'factpack',
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'build a pack' }],
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    sink,
  }).then(
    (result) => ({ result, sink }),
    (error: unknown) => ({ error, sink }),
  )
}

describe('callModel transport', () => {
  it('streams a call allowed to run longer than undici’s 300s headers timeout', async () => {
    const { result, sink } = (await run(600_000)) as { result: CallModelResult; sink: Sink }
    expect(calls).toMatchObject({ create: 0, stream: 1 })
    // Web searches are billed per request: the streamed usage must still reach the cost.
    expect(result.usage.web_searches).toBe(5)
    expect(sink.rows[0]?.cost_usd).toBe(result.costUsd)
    expect(result.costUsd).toBeGreaterThan(0)
  })

  it('keeps an ordinary call on plain create()', async () => {
    await run()
    await run(120_000)
    expect(calls).toMatchObject({ create: 2, stream: 0 })
  })

  it('enforces timeoutMs over the whole stream, does not retry, and logs partial usage', async () => {
    // The SDK's own `timeout` only covers the headers; one real build streamed for 50 minutes.
    const fire = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      setTimeout(() => fire.abort(new DOMException('deadline', 'TimeoutError')), 5)
      return fire.signal
    })
    calls.hang = true

    const { error, sink } = (await run(600_000, 1)) as { error: Error; sink: Sink }
    expect(error.message).toMatch(/deadline: exceeded timeoutMs=600000/)
    expect(calls.stream).toBe(1) // maxRetries: 1, and still only one attempt
    expect(sink.rows).toHaveLength(1)
    const row = sink.rows[0]!
    expect(row.ok).toBe(false)
    // Not $0: the tokens the stream had reported before it was cut off.
    expect(row.input_tokens).toBe(200_000)
    expect(row.output_tokens).toBe(700)
    expect(row.cost_usd).toBeGreaterThan(0)
    expect(row.error).toMatch(/^\[partial usage, lower bound\]/)
  })
})
