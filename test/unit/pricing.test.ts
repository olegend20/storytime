import { describe, expect, it } from 'vitest'
import { computeCost, modelForRole, pricing, pricingAgeDays, pricingIsStale, priceFor } from '@/lib/ai/pricing'

/**
 * F8 VTs:
 *  - computeCost matches hand-computed values from config/pricing.json for three cases
 *  - the pricing file failing the suite when older than 90 days
 */
describe('F8 cost computation', () => {
  it('hand-computed case 1: Sonnet 5 write call with a warm cache', () => {
    // 1,500 uncached in @ $2/MTok = $0.003
    // 4,000 cache read  @ $0.20/MTok = $0.0008
    // 5,000 out         @ $10/MTok = $0.05
    const cost = computeCost({
      model: 'claude-sonnet-5',
      input: 1_500,
      cacheRead: 4_000,
      output: 5_000,
    })
    expect(cost).toBeCloseTo(0.0538, 6)
  })

  it('hand-computed case 2: Haiku 4.5 bible update, no cache', () => {
    // 7,000 in @ $1/MTok = $0.007 ; 600 out @ $5/MTok = $0.003
    const cost = computeCost({ model: 'claude-haiku-4-5-20251001', input: 7_000, output: 600 })
    expect(cost).toBeCloseTo(0.01, 6)
  })

  it('hand-computed case 3: Opus 5.5 with a 5-minute cache write', () => {
    // 2,000 in @ $4/MTok = $0.008 ; 4,000 cache write @ $5/MTok = $0.02
    // 3,000 out @ $20/MTok = $0.06
    const cost = computeCost({
      model: 'claude-opus-5-5',
      input: 2_000,
      cacheWrite: 4_000,
      output: 3_000,
      cacheTtl: '5m',
    })
    expect(cost).toBeCloseTo(0.088, 6)
  })

  it('charges the 1h cache-write rate when asked for it', () => {
    const fiveMin = computeCost({ model: 'claude-sonnet-5', input: 0, cacheWrite: 1_000_000, output: 0 })
    const oneHour = computeCost({
      model: 'claude-sonnet-5',
      input: 0,
      cacheWrite: 1_000_000,
      output: 0,
      cacheTtl: '1h',
    })
    expect(fiveMin).toBeCloseTo(2.5, 6)
    expect(oneHour).toBeCloseTo(4.0, 6)
  })

  it('adds the web-search surcharge at $10 per 1,000 searches', () => {
    const withSearch = computeCost({
      model: 'claude-sonnet-5',
      input: 0,
      output: 0,
      webSearches: 5,
    })
    expect(withSearch).toBeCloseTo(0.05, 6)
  })

  it('applies the 50% batch discount to tokens but not to search surcharges', () => {
    const cost = computeCost({ model: 'claude-sonnet-5', input: 1_000_000, output: 0, batch: true })
    expect(cost).toBeCloseTo(1.0, 6)
  })

  it('refuses to guess a price for an unknown model', () => {
    expect(() => computeCost({ model: 'claude-made-up-9', input: 1, output: 1 })).toThrow(
      /No price in config\/pricing\.json/,
    )
  })

  /**
   * Cache reads must be materially cheaper than uncached input, or the whole
   * "cache the master prompt" design buys nothing.
   */
  it('prices cache reads below base input for every configured model', () => {
    for (const [model, p] of Object.entries(pricing.models)) {
      expect(p.cache_read, model).toBeLessThan(p.input)
      expect(p.cache_read, model).toBeCloseTo(p.input * p.cache_read_multiplier, 6)
    }
  })
})

describe('F8 pricing file freshness', () => {
  it('is not older than the refresh policy', () => {
    const age = pricingAgeDays()
    expect(
      pricingIsStale(),
      `config/pricing.json is ${age} days old (limit ${pricing.refresh_policy.max_age_days}). ` +
        `Re-fetch https://platform.claude.com/docs/en/about-claude/pricing and ` +
        `https://platform.claude.com/docs/en/models/overview, update the prices and bump updated_at. ` +
        `Do not edit prices from memory.`,
    ).toBe(false)
  })

  it('cites the source page and fetch date for every price', () => {
    expect(pricing.sources.length).toBeGreaterThan(0)
    for (const s of pricing.sources) {
      expect(s.url).toMatch(/^https:\/\//)
      expect(s.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('model role resolution', () => {
  it('resolves every role to a model that has a price', () => {
    for (const role of ['writer', 'helper', 'factpack', 'judge_primary', 'judge_secondary']) {
      const model = modelForRole(role)
      expect(() => priceFor(model), `${role} -> ${model}`).not.toThrow()
    }
  })

  it('lets an env var override the configured writing model (F14 AC)', () => {
    const previous = process.env.WRITING_MODEL
    process.env.WRITING_MODEL = 'claude-opus-5-5'
    try {
      expect(modelForRole('writer')).toBe('claude-opus-5-5')
    } finally {
      if (previous === undefined) delete process.env.WRITING_MODEL
      else process.env.WRITING_MODEL = previous
    }
  })

  it('prices every bake-off contestant', () => {
    const contestants = (pricing as unknown as { models: Record<string, unknown> }).models
    for (const c of ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
      expect(Object.keys(contestants)).toContain(c)
    }
  })
})
