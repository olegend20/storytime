import { describe, expect, it } from 'vitest'
import { MemoryLogSink, MeteredLogSink, type GenerationLogRow, type GenerationLogSink } from '@/lib/ai'

/**
 * F8: the eval CLIs count a run's spend AND persist it. A bare MemoryLogSink passed as
 * `sink` replaces the default sink, so the eval, bake-off and reliability runs were counted
 * on screen and never reached generation_logs.
 */
const row = (cost: number): GenerationLogRow => ({
  family_id: null,
  story_id: null,
  fact_pack_id: null,
  purpose: 'write',
  model: 'claude-sonnet-5',
  input_tokens: 1,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  output_tokens: 1,
  cost_usd: cost,
  latency_ms: 1,
  ok: true,
  error: null,
})

describe('MeteredLogSink', () => {
  it('counts every row and forwards every row', async () => {
    const persisted = new MemoryLogSink()
    const sink = new MeteredLogSink(persisted)
    await sink.write(row(0.5))
    await sink.write(row(0.25))
    expect(sink.totalCostUsd).toBe(0.75)
    expect(persisted.rows).toHaveLength(2)
  })

  it('still counts when the persisting sink throws', async () => {
    const broken: GenerationLogSink = { write: async () => { throw new Error('down') } }
    const sink = new MeteredLogSink(broken)
    await sink.write(row(1))
    expect(sink.totalCostUsd).toBe(1)
  })
})
