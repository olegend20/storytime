import { describe, expect, it } from 'vitest'
import { loadPrompt } from '@/lib/prompts'
import { reviewFactPackDeterministic } from '@/lib/topics/review'
import { goodFactPack } from '../helpers/story'

/**
 * Issue #28 (VT-FP4). A pack written from the model's own knowledge has no sources by design
 * (DECISIONS #139). The first such pack to meet the reviewer was rejected for exactly that
 * ("No sources provided despite 22 facts"), and the topic died. Both halves of the review
 * must accept a sourceless pack on its merits.
 */
describe('the fact-pack review and a pack with no sources', () => {
  it('the review prompt says missing sources are by design, never a fault', () => {
    const prompt = loadPrompt('factpack-review')
    expect(prompt.version).toBeGreaterThanOrEqual(2)
    expect(prompt.body).toMatch(/Some packs have no sources, on purpose/)
    expect(prompt.body).toMatch(/never reject a pack for having no sources/)
    expect(prompt.body).toMatch(/never for having none/)
    expect(prompt.body).not.toMatch(/Structural checks \(fact count, missing sources, size\)/)
  })

  it('the deterministic review accepts a sourceless pack whose facts cite nothing', () => {
    const pack = {
      ...goodFactPack(),
      sources: [],
      facts: goodFactPack().facts.map((f) => ({ ...f, source_ids: [] })),
    }
    const review = reviewFactPackDeterministic(pack)
    expect(review.reasons).toEqual([])
    expect(review.accept).toBe(true)
  })
})
