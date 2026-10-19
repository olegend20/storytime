import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Issue #58: the review bench scores Claude Haiku 5.5, which thinks unless told not to.
 * What reaches the API for it, and that every other model's request is unchanged.
 */

const captured = vi.hoisted(() => ({ params: [] as Record<string, unknown>[] }))

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
  const review = JSON.stringify({
    age_appropriate: true,
    scary_level: 0,
    kids_are_active_participants: true,
    facts_consistent_with_pack: true,
    tone_matches_request: true,
    reasons: [],
  })
  const message = {
    id: 'msg_stub',
    content: [{ type: 'text', text: review }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
  class StubAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        captured.params.push(params)
        const stream = { on: () => stream, currentMessage: message, finalMessage: async () => message }
        return stream
      },
    }
  }
  return { ...actual, default: StubAnthropic }
})

const { callModel } = await import('@/lib/ai/callModel')
const { MemoryLogSink } = await import('@/lib/ai/types')
const { runQualityReview } = await import('@/lib/quality/review')
const { modelForRole } = await import('@/lib/ai/pricing')

const saved = process.env.LIVE_API
afterEach(() => {
  captured.params.length = 0
  if (saved === undefined) delete process.env.LIVE_API
  else process.env.LIVE_API = saved
})

const call = (model: string, extra: { thinking?: 'adaptive' | 'off'; effort?: 'low' | 'medium' | 'high' } = {}) =>
  callModel({ purpose: 'quality', model, messages: [{ role: 'user', content: 'review' }], sink: new MemoryLogSink(), ...extra })

describe('Claude Haiku 5.5 request shape', () => {
  it('thinking off is said explicitly on Haiku 5.5, and stays omitted on every other model', async () => {
    process.env.LIVE_API = '1'
    await call('claude-haiku-5-5', { thinking: 'off' })
    await call('claude-haiku-4-5-20251001', { thinking: 'off' })
    await call('claude-sonnet-5', { thinking: 'off' })
    expect(captured.params[0]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(captured.params[1]).not.toHaveProperty('thinking')
    expect(captured.params[2]).not.toHaveProperty('thinking')
  })

  it('takes effort, and never a temperature', async () => {
    process.env.LIVE_API = '1'
    await call('claude-haiku-5-5', { effort: 'high' })
    expect(captured.params[0]).toMatchObject({ output_config: { effort: 'high' } })
    expect(captured.params[0]).not.toHaveProperty('temperature')
    expect(captured.params[0]).not.toHaveProperty('thinking')
  })

  it('a quality review on Haiku 5.5 leaves room for its thinking; with thinking off, or on Haiku 4.5, 2,000', async () => {
    process.env.LIVE_API = '1'
    const story = { title: 't', subtitle: null, chapters: [{ heading: 'h', text: 'Once.' }], true_facts: [] } as never
    const request = { age_band: 'A', children: [{ name: 'Mia', age: 4 }], tones: ['calm'], length_minutes: 5, topic_label: 'bees' } as never
    const fast = await runQualityReview(story, request, null, { model: 'claude-haiku-5-5', sink: new MemoryLogSink() })
    await runQualityReview(story, request, null, { model: 'claude-haiku-5-5', thinking: 'off', sink: new MemoryLogSink() })
    await runQualityReview(story, request, null, { model: 'claude-haiku-4-5-20251001', sink: new MemoryLogSink() })
    expect(fast.valid).toBe(true)
    expect(captured.params.map((p) => [p.model, p.max_tokens])).toEqual([
      ['claude-haiku-5-5', 16_000],
      ['claude-haiku-5-5', 2_000],
      ['claude-haiku-4-5-20251001', 2_000],
    ])
  })

  it('#201: the shipped quality review runs on its own role - Haiku 5.5, thinking on at the default effort', async () => {
    process.env.LIVE_API = '1'
    const story = { title: 't', subtitle: null, chapters: [{ heading: 'h', text: 'Once.' }], true_facts: [] } as never
    const request = { age_band: 'A', children: [{ name: 'Mia', age: 4 }], tones: ['calm'], length_minutes: 5, topic_label: 'bees' } as never
    expect(modelForRole('quality_reviewer')).toBe('claude-haiku-5-5')
    await runQualityReview(story, request, null, { sink: new MemoryLogSink() })
    expect(captured.params[0]).toMatchObject({ model: 'claude-haiku-5-5', max_tokens: 16_000 })
    // Adaptive thinking is on by default on Haiku 5.5: no thinking param, no effort override,
    // and never a temperature (400 on this model).
    expect(captured.params[0]).not.toHaveProperty('thinking')
    expect(captured.params[0]).not.toHaveProperty('temperature')
    expect((captured.params[0] as { output_config?: { effort?: string } }).output_config?.effort).toBeUndefined()
    // The safety review and the other helper steps stay on the helper until each has its own eval.
    expect(modelForRole('helper')).toBe('claude-haiku-4-5-20251001')
  })
})
