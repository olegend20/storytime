import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * What the writing call sends: the constrained output format alongside adaptive thinking
 * and the cached master block - and how a model that rejects the format is handled.
 */

const captured = vi.hoisted(() => ({ params: [] as Record<string, unknown>[], reject400: false }))

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
  const message = {
    id: 'msg_stub',
    content: [{ type: 'text', text: '{"title":"t"}' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
  class StubAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        captured.params.push(params)
        const stream = {
          on: () => stream,
          finalMessage: async () => {
            if (captured.reject400) {
              throw new actual.APIError(400, { error: { message: 'output_config.format: schema is invalid' } }, 'output_config.format: schema is invalid', new Headers())
            }
            return message
          },
        }
        return stream
      },
    }
  }
  return { ...actual, default: StubAnthropic }
})

const { streamModel } = await import('@/lib/ai/streamModel')
const { STORY_OUTPUT_FORMAT } = await import('@/lib/generate/output-schema')
const { ModelCallError } = await import('@/lib/ai/types')

const saved = process.env.LIVE_API
afterEach(() => {
  captured.params.length = 0
  captured.reject400 = false
  if (saved === undefined) delete process.env.LIVE_API
  else process.env.LIVE_API = saved
})

describe('the writing call', () => {
  it('sends the story schema as output_config.format, with thinking, on the model itself', async () => {
    process.env.LIVE_API = '1'
    await streamModel({
      purpose: 'write',
      model: 'claude-sonnet-5',
      system: [{ text: 'master', cache: true }],
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 32_000,
      thinking: 'adaptive',
      outputFormat: STORY_OUTPUT_FORMAT,
    })
    const sent = captured.params[0]!
    expect(sent.output_config).toEqual({ format: STORY_OUTPUT_FORMAT })
    expect(sent.thinking).toEqual({ type: 'adaptive' })
    expect(sent.max_tokens).toBe(32_000)
    expect((sent.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('surfaces a 400 with its status, so the pipeline can retry without the format', async () => {
    process.env.LIVE_API = '1'
    captured.reject400 = true
    const err = await streamModel({
      purpose: 'write',
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'write' }],
      maxTokens: 32_000,
      outputFormat: STORY_OUTPUT_FORMAT,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ModelCallError)
    expect((err as InstanceType<typeof ModelCallError>).detail.status).toBe(400)
    expect((err as Error).message).toMatch(/output_config/)
  })
})

describe('structuredOutputRejected', () => {
  it('is true only for a 400 about the output format, never for billing or transport', async () => {
    const { structuredOutputRejected } = await import('@/lib/ai/callModel')
    const err = (status: number | undefined, message: string) =>
      new ModelCallError(message, { purpose: 'write', model: 'm', attempts: 1, retryable: false, status })
    expect(structuredOutputRejected(err(400, 'output_config.format: unsupported'))).toBe(true)
    expect(structuredOutputRejected(err(400, 'json_schema could not be compiled'))).toBe(true)
    expect(structuredOutputRejected(err(400, 'Your credit balance is too low'))).toBe(false)
    expect(structuredOutputRejected(err(529, 'overloaded: schema'))).toBe(false)
    expect(structuredOutputRejected(new Error('schema'))).toBe(false)
  })
})
