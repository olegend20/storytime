import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelCallError } from '@/lib/ai/types'

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
  /** Streams that start, then drop with this error, before the next one succeeds. */
  drop: [] as Error[],
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
        const drop = calls.drop.shift()
        if (drop) {
          // message_start arrived (usage so far), then the connection was cut. Rejected the
          // way the real MessageStream does it: an SDK error passes through, anything else is
          // rewrapped as a plain AnthropicError with the original as its cause.
          const surfaced =
            drop instanceof actual.AnthropicError
              ? drop
              : Object.assign(new actual.AnthropicError(drop.message), { cause: drop })
          return {
            on: () => undefined,
            currentMessage: { ...message, usage: { ...message.usage, output_tokens: 7 } },
            finalMessage: () => Promise.reject(surfaced),
          }
        }
        // `on`: callModel listens for `connect` to read the gateway's headers (#76); a stub never connects.
        if (!calls.hang) return { on: () => undefined, finalMessage: async () => message, currentMessage: message }
        // A stream that has started (message_start carried usage) and then never finishes.
        return {
          on: () => undefined,
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

const { callModel, isDroppedStream } = await import('@/lib/ai/callModel')
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
  calls.drop = []
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

/** undici's error when the other side closes a stream mid-response. */
function terminated(): Error {
  return new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })
}

const rewrite = (opts: { maxRetries?: number; maxDrops?: number; deadlineAt?: number; minRetryMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}) => {
  process.env.LIVE_API = '1'
  const sink = new MemoryLogSink()
  return callModel({
    purpose: 'rewrite',
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'rewrite the story' }],
    timeoutMs: opts.timeoutMs ?? 600_000,
    ...opts,
    sink,
  }).then(
    (result) => ({ result, error: null as Error | null, sink }),
    (error: Error) => ({ result: null, error, sink }),
  )
}

describe('issue #50: a stream the gateway drops partway is tried once more', () => {
  it('VT-R1 a dropped stream is retried and the second answer returned; both attempts are logged', async () => {
    calls.drop = [terminated()]
    const { result, sink } = await rewrite()
    expect(calls.stream).toBe(2)
    expect(result!.text).toBe('ok')
    expect(sink.rows).toHaveLength(2)
    expect(sink.rows[0]!.ok).toBe(false)
    expect(sink.rows[0]!.error).toMatch(/^\[partial usage, lower bound\] terminated/)
    expect(sink.rows[0]!.output_tokens).toBe(7)
    expect(sink.rows[1]!.ok).toBe(true)
    // A reset socket counts too.
    calls.stream = 0
    calls.drop = [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })]
    expect((await rewrite()).result!.text).toBe('ok')
    expect(calls.stream).toBe(2)
  })

  it('VT-R2 by default at most one retry for a dropped stream, whatever maxRetries says', async () => {
    calls.drop = [terminated(), terminated(), terminated()]
    const { error, sink } = await rewrite({ maxRetries: 5 })
    expect(calls.stream).toBe(2)
    expect(error!.message).toMatch(/rewrite call to claude-sonnet-5 failed after 2 attempt\(s\): terminated/)
    expect(sink.rows.every((r) => !r.ok)).toBe(true)
    // And maxRetries: 0 still means no retry at all.
    calls.stream = 0
    calls.drop = [terminated()]
    await rewrite({ maxRetries: 0 })
    expect(calls.stream).toBe(1)
  })

  it('VT-R2 (#72) maxDrops retries that many drops, still within maxRetries', async () => {
    calls.drop = [terminated(), terminated(), terminated()]
    expect((await rewrite({ maxDrops: 3, maxRetries: 3 })).result!.text).toBe('ok')
    expect(calls.stream).toBe(4)

    // maxRetries still caps it: three attempts, then the drop is the error.
    calls.stream = 0
    calls.drop = [terminated(), terminated(), terminated(), terminated()]
    const { error } = await rewrite({ maxDrops: 3, maxRetries: 2 })
    expect(calls.stream).toBe(3)
    expect(error!.message).toMatch(/failed after 3 attempt\(s\): terminated/)
    // The pipeline tells a lost rewrite's cause by this flag, not the message (#73 review).
    expect((error as ModelCallError).detail.dropped).toBe(true)
  })

  it('VT-R3 no retry without minRetryMs left, and no attempt runs past deadlineAt', async () => {
    calls.drop = [terminated()]
    const { error } = await rewrite({ deadlineAt: Date.now() + 60_000, minRetryMs: 105_000 })
    expect(calls.stream).toBe(1)
    expect(error!.message).toMatch(/after 1 attempt\(s\): terminated/)

    // Plenty of time: retried, and each attempt's own deadline is capped at what is left.
    calls.stream = 0
    calls.drop = [terminated()]
    const asked: number[] = []
    const real = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      asked.push(ms)
      return real(ms)
    })
    const { result } = await rewrite({ deadlineAt: Date.now() + 400_000, minRetryMs: 105_000 })
    expect(result!.text).toBe('ok')
    expect(calls.stream).toBe(2)
    expect(asked).toHaveLength(2)
    for (const ms of asked) {
      expect(ms).toBeLessThanOrEqual(400_000)
      expect(ms).toBeGreaterThan(390_000)
    }
  })

  it('VT-R4 our own deadline, a caller abort, a 4xx and a refusal are unchanged', async () => {
    // Our deadline on a long call: still not retried.
    fastDeadline()
    calls.hang = true
    await rewrite({ maxRetries: 2 })
    expect(calls.stream).toBe(1)
    vi.restoreAllMocks()
    calls.hang = false

    // A caller that gives up (a parent closing the page) is not retried.
    calls.stream = 0
    calls.hang = true
    const caller = new AbortController()
    setTimeout(() => caller.abort(), 50)
    expect((await rewrite({ signal: caller.signal })).error).not.toBeNull()
    expect(calls.stream).toBe(1)
    calls.hang = false

    const { BadRequestError } = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')

    // A 400 we caused is not a drop either.
    calls.stream = 0
    calls.drop = [new BadRequestError(400, { type: 'error' }, 'bad request', new Headers())]
    expect((await rewrite()).error).not.toBeNull()
    expect(calls.stream).toBe(1)

    // Neither is a plain TypeError of our own making, wrapped or not.
    const { AnthropicError } = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
    const ours = new TypeError('cannot read properties of undefined')
    expect(isDroppedStream(ours)).toBe(false)
    expect(isDroppedStream(Object.assign(new AnthropicError(ours.message), { cause: ours }))).toBe(false)
    // The drop as the SDK really surfaces it, and bare.
    expect(isDroppedStream(Object.assign(new AnthropicError('terminated'), { cause: terminated() }))).toBe(true)
    expect(isDroppedStream(terminated())).toBe(true)
  })

  it('VT-R5 the pipeline\'s rewrite passes the request deadline, with rung 3\'s floor', () => {
    const source = readFileSync(join(process.cwd(), 'lib/generate/pipeline.ts'), 'utf8')
    const rewriteCall = source.slice(source.indexOf("purpose: 'rewrite',\n          role: 'writer',\n          ...(deps.writingModel ? { model: deps.writingModel } : {}),\n          system: rewritePrompt.system"))
    expect(rewriteCall.slice(0, 1200)).toMatch(
      /deadlineAt: deps\.deadlineMs - AFTER_WRITE_MS, minRetryMs: RETRY_MIN_MS - AFTER_WRITE_MS/,
    )
  })

  it('VT-R6 (#72) the pipeline\'s rewrite retries up to MAX_DROP_RETRIES drops', () => {
    const source = readFileSync(join(process.cwd(), 'lib/generate/pipeline.ts'), 'utf8')
    const rewriteCall = source.slice(source.indexOf("purpose: 'rewrite',\n          role: 'writer',\n          ...(deps.writingModel ? { model: deps.writingModel } : {}),\n          system: rewritePrompt.system"))
    expect(rewriteCall.slice(0, 1400)).toMatch(/maxDrops: MAX_DROP_RETRIES, maxRetries: MAX_DROP_RETRIES/)
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
