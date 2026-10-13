import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Every live call streams (issue #41).
 *
 * A non-streaming response sends nothing until it is finished. Node's fetch (undici) abandons
 * one whose headers take more than 300s - every fact-pack build once lost its first attempt at
 * exactly 300.0s - and the Understudy gateway closes one with no first byte after ~125s.
 * Streaming must leave the request, the tokens and the cost exactly as they were. The SDK is
 * stubbed so the live path runs without the network.
 */

const calls = vi.hoisted(() => ({
  create: 0,
  stream: 0,
  hang: false,
  params: [] as Record<string, unknown>[],
  ctor: [] as unknown[],
}))

const message = {
  id: 'msg_stub',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 200_000,
    output_tokens: 10_000,
    cache_read_input_tokens: 50_000,
    cache_creation_input_tokens: 4_000,
    server_tool_use: { web_search_requests: 5 },
  },
}

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
  class StubAnthropic {
    constructor(opts: unknown) {
      calls.ctor.push(opts)
    }
    messages = {
      create: async () => {
        calls.create += 1
        return message
      },
      stream: (params: Record<string, unknown>, opts: { signal?: AbortSignal }) => {
        calls.stream += 1
        calls.params.push(params)
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
const { computeCost } = await import('@/lib/ai/pricing')
type Sink = InstanceType<typeof MemoryLogSink>
type CallModelResult = Awaited<ReturnType<typeof callModel>>

const saved = process.env.LIVE_API

afterEach(() => {
  vi.restoreAllMocks()
  calls.create = 0
  calls.stream = 0
  calls.hang = false
  calls.params = []
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

/** Make the next AbortSignal.timeout() fire almost at once, and record the ms it was given. */
function fastDeadline(): number[] {
  const asked: number[] = []
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    asked.push(ms)
    const fire = new AbortController()
    setTimeout(() => fire.abort(new DOMException('deadline', 'TimeoutError')), 5)
    return fire.signal
  })
  return asked
}

describe('callModel transport', () => {
  it('VT-1 every live call streams, whatever its timeout', async () => {
    await run()
    await run(120_000)
    await run(600_000)
    expect(calls).toMatchObject({ create: 0, stream: 3 })
  })

  it('VT-2 the request is unchanged: model, cached system, tools and limits reach stream() as built', async () => {
    process.env.LIVE_API = '1'
    const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]
    await callModel({
      purpose: 'factpack',
      model: 'claude-haiku-4-5-20251001',
      system: [
        { text: 'stable rules', cache: true },
        { text: 'tonight only' },
      ],
      messages: [{ role: 'user', content: 'build a pack' }],
      tools: tools as never,
      maxTokens: 1234,
      sink: new MemoryLogSink(),
    })
    expect(calls.params).toHaveLength(1)
    expect(calls.params[0]).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1234,
      messages: [{ role: 'user', content: 'build a pack' }],
      system: [
        { type: 'text', text: 'stable rules', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'tonight only' },
      ],
      tools,
    })
  })

  it('VT-3 the cost is unchanged: cache tokens and web searches reach cost_usd and the log row', async () => {
    const { result, sink } = (await run()) as { result: CallModelResult; sink: Sink }
    expect(result.usage).toEqual({
      input_tokens: 200_000,
      cache_read_tokens: 50_000,
      cache_write_tokens: 4_000,
      output_tokens: 10_000,
      web_searches: 5,
    })
    expect(result.costUsd).toBe(
      computeCost({
        model: 'claude-sonnet-5',
        input: 200_000,
        cacheRead: 50_000,
        cacheWrite: 4_000,
        output: 10_000,
        webSearches: 5,
      }),
    )
    expect(sink.rows).toHaveLength(1)
    expect(sink.rows[0]?.cost_usd).toBe(result.costUsd)
  })

  it('VT-4 timeoutMs bounds the whole call at any size; every attempt logs its partial usage', async () => {
    // The SDK's own `timeout` only covers the headers; one real build streamed for 50 minutes.
    for (const budget of [120_000, 600_000]) {
      const asked = fastDeadline()
      calls.hang = true
      calls.stream = 0

      const { error, sink } = (await run(budget, 1)) as { error: Error; sink: Sink }
      expect(asked.every((ms) => ms === budget)).toBe(true)
      expect(error.message).toMatch(new RegExp(`deadline: exceeded timeoutMs=${budget}`))
      expect(sink.rows).toHaveLength(calls.stream)
      for (const row of sink.rows) {
        expect(row.ok).toBe(false)
        // Not $0: the tokens the stream had reported before it was cut off.
        expect(row.input_tokens).toBe(200_000)
        expect(row.output_tokens).toBe(700)
        expect(row.cost_usd).toBeGreaterThan(0)
        expect(row.error).toMatch(/^\[partial usage, lower bound\]/)
      }
      vi.restoreAllMocks()
    }
  })

  it('VT-4 a long call (over five minutes) that hits its deadline is not retried', async () => {
    fastDeadline()
    calls.hang = true
    await run(600_000, 1)
    expect(calls.stream).toBe(1) // maxRetries: 1, and still only one attempt
  })

  it('VT-4 a shorter call that times out keeps its retry, as it had before every call streamed', async () => {
    // The fact-pack builders (lib/topics/build.ts) set 240-280s with maxRetries: 1.
    fastDeadline()
    calls.hang = true
    await run(280_000, 1)
    expect(calls.stream).toBe(2)
  })

  it('VT-4 a call with no timeoutMs is still bounded, by the SDK default of ten minutes, and retried', async () => {
    const asked = fastDeadline()
    calls.hang = true
    const { error } = (await run(undefined, 1)) as { error: Error }
    expect(asked).toEqual([600_000, 600_000])
    expect(error.message).toMatch(/deadline: exceeded timeoutMs=600000/)
    expect(calls.stream).toBe(2)
  })
})

describe('VT-5 the base URL comes from the environment', () => {
  it('callModel builds its client with no baseURL of its own', async () => {
    await run()
    expect(calls.ctor).toEqual([{ maxRetries: 0 }])
  })

  it('no model wrapper hard-codes a base URL', () => {
    for (const file of ['lib/ai/callModel.ts', 'lib/ai/streamModel.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source, file).toContain('new Anthropic({ maxRetries: 0 })')
      expect(source, file).not.toMatch(/baseURL|api\.anthropic\.com/)
    }
  })

  it('the SDK picks up ANTHROPIC_BASE_URL, so the gateway needs no code change', async () => {
    const { default: Real } = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
    const before = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example'
    try {
      expect(new Real({ apiKey: 'test', maxRetries: 0 }).baseURL).toBe('https://gateway.example')
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = before
    }
  })
})
