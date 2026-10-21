import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import type { CallPurpose } from '@/lib/schemas/common'
import { capabilities, computeCost, modelForRole } from './pricing'
import { MissingFixtureError, fixtureKey, readFixture, writeFixture } from './fixtures'
import { getDefaultLogSink, isDroppedStream, isUpstreamStreamError, normalizeUsage, type CacheableBlock, type CallModelResult } from './callModel'
import { ModelCallError, ModelRefusalError, type GenerationLogSink } from './types'
import { servedByOtherModel, understudyHeaders, workloadFor } from './workload'

/**
 * Streaming variant of the wrapper, for F6's SSE route. Kickoff rule 1 means lane 2
 * must not reach for the SDK directly even for streaming - so the primitive lives here.
 *
 * In replay mode the recorded text is emitted in chunks so the progressive-rendering
 * e2e test (F6 VT) exercises the same code path as production without a network call.
 */

export interface StreamModelOptions {
  purpose: CallPurpose
  role?: string
  model?: string
  system?: CacheableBlock[]
  messages: Anthropic.MessageParam[]
  maxTokens?: number
  thinking?: 'adaptive' | 'off'
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /**
   * Structured outputs: `output_config.format`. The reply is constrained to the schema, so
   * it cannot arrive as malformed JSON. Works with streaming and with thinking.
   */
  outputFormat?: Record<string, unknown>
  familyId?: string | null
  storyId?: string | null
  sink?: GenerationLogSink
  signal?: AbortSignal
  /** Called with each text delta as it arrives. */
  onText?: (delta: string) => void
  /** Replay-only: chunk size for simulated deltas. */
  replayChunkSize?: number
  /** The rest of a story after a drop (#74): tagged as its own Understudy workload (#76). */
  continuation?: boolean
}

const DEFAULT_STREAM_MAX_TOKENS = 64_000

function isLive(): boolean {
  return process.env.LIVE_API === '1' || process.env.LIVE_API === 'true'
}
function isRecording(): boolean {
  return process.env.RECORD_FIXTURES === '1' || process.env.RECORD_FIXTURES === 'true'
}

let client: Anthropic | null = null
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ maxRetries: 0 })
  return client
}

export async function streamModel(opts: StreamModelOptions): Promise<CallModelResult<never>> {
  const model = opts.model ?? modelForRole(opts.role ?? 'writer')
  const sink = opts.sink ?? getDefaultLogSink()
  const maxTokens = opts.maxTokens ?? DEFAULT_STREAM_MAX_TOKENS
  const caps = capabilities(model)

  const system = opts.system?.map((b) => {
    const block: Record<string, unknown> = { type: 'text', text: b.text }
    if (b.cache) {
      block.cache_control = { type: 'ephemeral', ...(b.cacheTtl === '1h' ? { ttl: '1h' } : {}) }
    }
    return block
  })

  const thinkingMode = caps.thinking as string | undefined
  const thinking =
    opts.thinking === 'adaptive' &&
    thinkingMode !== 'always_on_omit_param' &&
    thinkingMode !== 'extended_budget_tokens'
      ? { type: 'adaptive' as const }
      : undefined
  const effort = opts.effort && caps.supports_effort === true ? { effort: opts.effort } : {}
  const format = opts.outputFormat ? { format: opts.outputFormat } : {}
  const merged = { ...effort, ...format }
  const outputConfig = Object.keys(merged).length > 0 ? merged : undefined

  const key = fixtureKey({
    model,
    system,
    messages: opts.messages,
    max_tokens: maxTokens,
    output_config: outputConfig,
    thinking,
  })

  // ---- Replay: emit recorded text as deltas, no network. ----
  if (!isLive()) {
    const fixture = readFixture(opts.purpose, key)
    if (!fixture) throw new MissingFixtureError(opts.purpose, key, model)
    const content = (fixture.response as { content?: unknown }).content
    const text = Array.isArray(content)
      ? content
          .filter((b) => (b as { type?: string }).type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('')
      : ''
    const size = opts.replayChunkSize ?? 400
    for (let i = 0; i < text.length; i += size) {
      opts.onText?.(text.slice(i, i + size))
    }
    const usage = { ...fixture.usage, web_searches: fixture.usage.web_searches ?? 0 }
    await sink.write({
      family_id: opts.familyId ?? null,
      story_id: opts.storyId ?? null,
      fact_pack_id: null,
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
      }),
      latency_ms: 0,
      ok: true,
      error: null,
    })
    return {
      text,
      data: null,
      usage,
      costUsd: computeCost({
        model,
        input: usage.input_tokens,
        cacheRead: usage.cache_read_tokens,
        cacheWrite: usage.cache_write_tokens,
        output: usage.output_tokens,
      }),
      latencyMs: 0,
      model,
      stopReason: fixture.stop_reason,
      replayed: true,
      raw: fixture.response,
    }
  }

  // ---- Live stream. ----
  const started = Date.now()
  let stream: ReturnType<ReturnType<typeof anthropic>['messages']['stream']> | null = null
  try {
    stream = anthropic().messages.stream(
      {
        model,
        max_tokens: maxTokens,
        messages: opts.messages,
        ...(system ? { system: system as unknown as Anthropic.TextBlockParam[] } : {}),
        ...(thinking ? { thinking } : {}),
        ...(outputConfig ? { output_config: outputConfig } : {}),
      } as unknown as Anthropic.MessageStreamParams,
      { signal: opts.signal, headers: understudyHeaders(workloadFor(opts.purpose, { continuation: opts.continuation })) },
    )

    if (opts.onText) stream.on('text', (delta: string) => opts.onText?.(delta))

    const finalMessage = (await stream.finalMessage()) as unknown as Record<string, unknown>
    const latencyMs = Date.now() - started
    const u = (finalMessage.usage ?? {}) as Record<string, number>
    const usage = {
      input_tokens: u.input_tokens ?? 0,
      cache_read_tokens: u.cache_read_input_tokens ?? 0,
      cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      web_searches: 0,
    }
    const stopReason = (finalMessage.stop_reason as string | null) ?? null
    const content = finalMessage.content
    const text = Array.isArray(content)
      ? content
          .filter((b) => (b as { type?: string }).type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('')
      : ''

    const costUsd = computeCost({
      model,
      input: usage.input_tokens,
      cacheRead: usage.cache_read_tokens,
      cacheWrite: usage.cache_write_tokens,
      output: usage.output_tokens,
    })

    // A reply from another model than the one asked for is never used (#76).
    const other = servedByOtherModel(model, stream.response?.headers)
    if (other) {
      await sink.write({
        family_id: opts.familyId ?? null,
        story_id: opts.storyId ?? null,
        fact_pack_id: null,
        purpose: opts.purpose,
        model,
        input_tokens: usage.input_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: costUsd,
        latency_ms: latencyMs,
        ok: false,
        error: `served_by_other_model:${other}`.slice(0, 500),
      })
      throw new ModelCallError(`${opts.purpose} stream to ${model} was served by ${other}`, {
        purpose: opts.purpose,
        model,
        attempts: 1,
        retryable: false,
        servedBy: other,
      })
    }

    await sink.write({
      family_id: opts.familyId ?? null,
      story_id: opts.storyId ?? null,
      fact_pack_id: null,
      purpose: opts.purpose,
      model,
      input_tokens: usage.input_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      ok: stopReason !== 'refusal',
      error: stopReason === 'refusal' ? 'refusal' : null,
    })

    if (stopReason === 'refusal') {
      const details = (finalMessage.stop_details ?? {}) as Record<string, unknown>
      throw new ModelRefusalError(
        model,
        (details.category as string | null) ?? null,
        (details.explanation as string | null) ?? null,
      )
    }

    if (isRecording()) {
      writeFixture(opts.purpose, key, {
        purpose: opts.purpose,
        model,
        response: finalMessage,
        usage: {
          input_tokens: usage.input_tokens,
          cache_read_tokens: usage.cache_read_tokens,
          cache_write_tokens: usage.cache_write_tokens,
          output_tokens: usage.output_tokens,
        },
        stop_reason: stopReason,
        recorded_at: new Date().toISOString(),
      })
    }

    return { text, data: null, usage, costUsd, latencyMs, model, stopReason, replayed: false, raw: finalMessage }
  } catch (err) {
    // Both are logged where they are raised.
    if (err instanceof ModelRefusalError || err instanceof ModelCallError) throw err
    const latencyMs = Date.now() - started
    // A stream cut partway has already used tokens - the thinking before the cut is billed.
    // Log what it reported so far, a LOWER BOUND, as callModel does (#50), not $0: since #52
    // retries the write, the cut attempt belongs to a story that is saved.
    const partial = stream?.currentMessage?.usage
    const used = partial ? normalizeUsage(partial) : null
    const message = err instanceof Error ? err.message : String(err)
    await sink.write({
      family_id: opts.familyId ?? null,
      story_id: opts.storyId ?? null,
      fact_pack_id: null,
      purpose: opts.purpose,
      model,
      input_tokens: used?.input_tokens ?? 0,
      cache_read_tokens: used?.cache_read_tokens ?? 0,
      cache_write_tokens: used?.cache_write_tokens ?? 0,
      output_tokens: used?.output_tokens ?? 0,
      cost_usd: used
        ? computeCost({ model, input: used.input_tokens, cacheRead: used.cache_read_tokens, cacheWrite: used.cache_write_tokens, output: used.output_tokens })
        : 0,
      latency_ms: latencyMs,
      ok: false,
      error: `${used ? '[partial usage, lower bound] ' : ''}${message}`.slice(0, 500),
    })
    throw new ModelCallError(
      `${opts.purpose} stream to ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
      {
        purpose: opts.purpose,
        model,
        attempts: 1,
        retryable: false,
        // The SDK's 'Connection error.' (APIConnectionError, a subclass of APIError) is the same
        // failure seen before the first byte: two first writes in the v5 eval died one each way.
        // An upstream error event mid-stream is the same loss, told rather than cut (#74).
        dropped: isDroppedStream(err) || err instanceof APIConnectionError || isUpstreamStreamError(err),
        ...(err instanceof APIError && typeof err.status === 'number' ? { status: err.status } : {}),
      },
    )
  }
}
