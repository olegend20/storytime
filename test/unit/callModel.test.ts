import { beforeEach, describe, expect, it } from 'vitest'
import { callModel, parseJsonLoose } from '@/lib/ai/callModel'
import { MissingFixtureError, fixtureKey, stableStringify, writeFixture } from '@/lib/ai/fixtures'
import { MemoryLogSink } from '@/lib/ai/types'
import { z } from 'zod'

/**
 * Kickoff rule 1 (one wrapper), rule 3 (fixtures by default).
 * These run with LIVE_API unset, so no test here may touch the network.
 */

describe('fixture keying', () => {
  it('is stable across object key ordering', () => {
    const a = fixtureKey({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 })
    const b = fixtureKey({ max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], model: 'm' })
    expect(a).toBe(b)
  })

  it('changes when the prompt changes, so a prompt edit misses the cache', () => {
    const a = fixtureKey({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
    const b = fixtureKey({ model: 'm', messages: [{ role: 'user', content: 'hello' }] })
    expect(a).not.toBe(b)
  })

  it('changes when the model changes', () => {
    const a = fixtureKey({ model: 'claude-sonnet-5', messages: [] })
    const b = fixtureKey({ model: 'claude-opus-5-5', messages: [] })
    expect(a).not.toBe(b)
  })

  it('sorts nested keys when stringifying', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
})

describe('replay mode', () => {
  it('throws an actionable MissingFixtureError rather than calling the API', async () => {
    await expect(
      callModel({
        purpose: 'normalize',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'a prompt with no recorded fixture' }],
      }),
    ).rejects.toThrow(MissingFixtureError)
  })

  it('names the record command in the error so the fix is obvious', async () => {
    await expect(
      callModel({
        purpose: 'normalize',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: 'another unrecorded prompt' }],
      }),
    ).rejects.toThrow(/RECORD_FIXTURES=1/)
  })
})

describe('replaying a recorded fixture', () => {
  const messages = [{ role: 'user' as const, content: 'normalize: how lego was invented' }]
  const model = 'claude-haiku-4-5-20251001'
  const key = fixtureKey({ model, messages, max_tokens: 16_000 })

  beforeEach(() => {
    writeFixture('normalize', key, {
      purpose: 'normalize',
      model,
      response: {
        content: [
          {
            type: 'text',
            text: '{"topic_key":"history-of-lego","topic_label":"The history of LEGO","is_appropriate_for_children":true,"reason":"educational"}',
          },
        ],
      },
      usage: { input_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 50 },
      stop_reason: 'end_turn',
      recorded_at: '2026-09-27T00:00:00.000Z',
    })
  })

  it('returns the recorded text, marked as replayed', async () => {
    const result = await callModel({ purpose: 'normalize', model, messages })
    expect(result.replayed).toBe(true)
    expect(result.text).toContain('history-of-lego')
    expect(result.latencyMs).toBe(0)
  })

  it('computes cost from the recorded usage', async () => {
    const result = await callModel({ purpose: 'normalize', model, messages })
    // 300 in @ $1/MTok + 50 out @ $5/MTok
    expect(result.costUsd).toBeCloseTo(0.00055, 6)
  })

  it('writes exactly one generation_logs row per call, with a non-null cost', async () => {
    const sink = new MemoryLogSink()
    await callModel({ purpose: 'normalize', model, messages, sink })
    expect(sink.rows).toHaveLength(1)
    expect(sink.rows[0]!.purpose).toBe('normalize')
    expect(sink.rows[0]!.ok).toBe(true)
    expect(sink.rows[0]!.cost_usd).toBeGreaterThan(0)
  })

  it('validates against a zod schema when one is supplied', async () => {
    const schema = z.object({
      topic_key: z.string(),
      topic_label: z.string(),
      is_appropriate_for_children: z.boolean(),
      reason: z.string(),
    })
    const result = await callModel({ purpose: 'normalize', model, messages, schema })
    expect(result.data?.topic_key).toBe('history-of-lego')
  })

  it('returns data:null rather than throwing when the payload fails validation', async () => {
    const schema = z.object({ definitely_absent: z.string() })
    const result = await callModel({ purpose: 'normalize', model, messages, schema })
    expect(result.data).toBeNull()
    expect(result.text.length).toBeGreaterThan(0)
  })

  it('correlates logs with the family and story ids given', async () => {
    const sink = new MemoryLogSink()
    const familyId = '11111111-1111-1111-1111-111111111111'
    await callModel({ purpose: 'normalize', model, messages, sink, familyId })
    expect(sink.rows[0]!.family_id).toBe(familyId)
  })
})

describe('cache_control placement', () => {
  it('marks only the blocks flagged stable, so a prompt edit cannot silently uncache', async () => {
    const model = 'claude-sonnet-5'
    const system = [
      { text: 'MASTER PROMPT (static)', cache: true },
      { text: 'bible + fact pack (varies)' },
    ]
    const messages = [{ role: 'user' as const, content: 'write a story' }]

    // Reconstruct what the wrapper builds, then assert the fixture key sees it.
    const built = [
      { type: 'text', text: 'MASTER PROMPT (static)', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'bible + fact pack (varies)' },
    ]
    const expectedKey = fixtureKey({ model, system: built, messages, max_tokens: 16_000 })

    writeFixture('write', expectedKey, {
      purpose: 'write',
      model,
      response: { content: [{ type: 'text', text: '{}' }] },
      usage: { input_tokens: 10, cache_read_tokens: 4000, cache_write_tokens: 0, output_tokens: 5 },
      stop_reason: 'end_turn',
      recorded_at: '2026-09-27T00:00:00.000Z',
    })

    const result = await callModel({ purpose: 'write', model, system, messages })
    expect(result.usage.cache_read_tokens).toBe(4000)
  })
})

describe('per-model capability handling', () => {
  const messages = [{ role: 'user' as const, content: 'capability probe' }]

  it('omits thinking entirely for Fable 5.1, which rejects any explicit config', async () => {
    const model = 'claude-fable-5-1'
    const key = fixtureKey({ model, messages, max_tokens: 16_000 })
    writeFixture('judge_score', key, {
      purpose: 'judge_score',
      model,
      response: { content: [{ type: 'text', text: 'ok' }] },
      usage: { input_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1 },
      stop_reason: 'end_turn',
      recorded_at: '2026-09-27T00:00:00.000Z',
    })
    // Asking for adaptive thinking must NOT add a thinking param on this model,
    // so the key computed without one still resolves.
    const result = await callModel({ purpose: 'judge_score', model, messages, thinking: 'adaptive' })
    expect(result.text).toBe('ok')
  })

  it('omits effort for Haiku 4.5, which does not support the parameter', async () => {
    const model = 'claude-haiku-4-5-20251001'
    const key = fixtureKey({ model, messages, max_tokens: 16_000 })
    writeFixture('quality', key, {
      purpose: 'quality',
      model,
      response: { content: [{ type: 'text', text: 'ok' }] },
      usage: { input_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1 },
      stop_reason: 'end_turn',
      recorded_at: '2026-09-27T00:00:00.000Z',
    })
    const result = await callModel({ purpose: 'quality', model, messages, effort: 'low' })
    expect(result.text).toBe('ok')
  })

  it('does send adaptive thinking to Sonnet 5, which accepts it', async () => {
    const model = 'claude-sonnet-5'
    const withThinking = fixtureKey({
      model,
      messages,
      max_tokens: 16_000,
      thinking: { type: 'adaptive' },
    })
    const withoutThinking = fixtureKey({ model, messages, max_tokens: 16_000 })
    expect(withThinking).not.toBe(withoutThinking)

    writeFixture('write', withThinking, {
      purpose: 'write',
      model,
      response: { content: [{ type: 'text', text: 'thought about it' }] },
      usage: { input_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1 },
      stop_reason: 'end_turn',
      recorded_at: '2026-09-27T00:00:00.000Z',
    })
    const result = await callModel({ purpose: 'write', model, messages, thinking: 'adaptive' })
    expect(result.text).toBe('thought about it')
  })
})

/** s4.4: the parser must repair a JSON payload wrapped in fences. */
describe('parseJsonLoose', () => {
  it('parses plain JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 })
  })
  it('strips ```json fences', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('strips bare ``` fences', () => {
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('recovers an object buried in prose', () => {
    expect(parseJsonLoose('Sure! Here it is:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 })
  })
  it('returns undefined on unrecoverable text, so the caller can run the repair pass', () => {
    expect(parseJsonLoose('this is not JSON at all')).toBeUndefined()
  })
})

describe('MemoryLogSink', () => {
  it('totals cost across rows', async () => {
    const sink = new MemoryLogSink()
    await sink.write({
      family_id: null, story_id: null, fact_pack_id: null,
      purpose: 'quality', model: 'claude-haiku-4-5-20251001',
      input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0,
      cost_usd: 0.007, latency_ms: 1, ok: true, error: null,
    })
    await sink.write({
      family_id: null, story_id: null, fact_pack_id: null,
      purpose: 'bible_update', model: 'claude-haiku-4-5-20251001',
      input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0,
      cost_usd: 0.01, latency_ms: 1, ok: true, error: null,
    })
    expect(sink.totalCostUsd).toBeCloseTo(0.017, 6)
  })
})
