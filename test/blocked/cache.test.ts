import { describe, expect, it } from 'vitest'
import { streamModel, MemoryLogSink, modelForRole } from '@/lib/ai'
import { buildPrompt } from '@/lib/generate/prompt'
import { StoryBible } from '@/lib/schemas'
import { estimateTokens, loadPrompt } from '@/lib/prompts'
import { FIXTURE_FACT_PACK } from '../helpers/factpack'
import { request } from '../helpers/story'

/**
 * F6 VT / AC: "Master prompt is sent with `cache_control`; after warm-up,
 * `cache_read_tokens` >= 90% of the master prompt size on every write call."
 *
 * This one CANNOT be proved from fixtures - a replayed run would only repeat a recorded
 * usage number - so it is live-only and skipped otherwise. §5 targets a writing-model cache
 * read rate of >= 90% of master-prompt tokens; if this test does not pass, the cost model in
 * §5 does not hold and the lead needs to know that rather than see a green tick.
 *
 * Run with:  LIVE_API=1 npx vitest run test/int/cache.test.ts
 */

const bible = StoryBible.parse({
  children: [
    { name: 'Milo', age: 7, likes: ['LEGO', 'sharks'], role_notes: 'often has the idea' },
    { name: 'Juno', age: 4, likes: ['dinosaurs'], role_notes: 'gets the shout-along lines' },
  ],
  recurring: [],
  catchphrases: [],
  topics_covered: [],
  last_story: null,
  tone_history: [],
  avoid: [],
})

describe('F6 VT (live): the master prompt is served from cache', () => {
  it('reads >= 90% of the cached master block on the second write call', async () => {
    const sink = new MemoryLogSink()
    const model = modelForRole('writer')

    // Two different stories. Identical cached prefix, different request block - which is
    // exactly the shape of two consecutive nights in production.
    const first = buildPrompt({
      request: { ...request(), topic_label: 'The history of LEGO' },
      bible,
      factPack: FIXTURE_FACT_PACK,
    })
    const second = buildPrompt({
      request: { ...request(), topic_label: 'Sharks', tones: ['exciting'] },
      bible,
      factPack: FIXTURE_FACT_PACK,
    })
    expect(second.system[0]!.text).toBe(first.system[0]!.text)

    const warm = await streamModel({
      purpose: 'write',
      model,
      system: first.system,
      messages: first.messages,
      maxTokens: 16_000,
      sink,
    })

    const hot = await streamModel({
      purpose: 'write',
      model,
      system: second.system,
      messages: second.messages,
      maxTokens: 16_000,
      sink,
    })

    // The cached prefix size, measured rather than estimated: cache_creation_input_tokens on
    // the cold call IS the size of the block that was cached.
    const cachedPrefix = warm.usage.cache_write_tokens + warm.usage.cache_read_tokens
    const ratio = cachedPrefix === 0 ? 0 : hot.usage.cache_read_tokens / cachedPrefix

    console.log(
      `[cache] model=${model} cold: write=${warm.usage.cache_write_tokens} read=${warm.usage.cache_read_tokens} ` +
        `uncached=${warm.usage.input_tokens} | hot: read=${hot.usage.cache_read_tokens} ` +
        `uncached=${hot.usage.input_tokens} | prefix=${cachedPrefix} ratio=${(ratio * 100).toFixed(1)}% ` +
        `| estimateTokens(master)=${estimateTokens(loadPrompt('master').body)} ` +
        `| cost cold=$${warm.costUsd.toFixed(4)} hot=$${hot.costUsd.toFixed(4)}`,
    )

    expect(cachedPrefix, 'the cold call cached nothing - cache_control never reached the API').toBeGreaterThan(0)
    expect(ratio, `cache read ratio ${(ratio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.9)

    // And the hot call must be cheaper, which is the whole reason for the breakpoint.
    expect(hot.costUsd).toBeLessThan(warm.costUsd)
  })
})
