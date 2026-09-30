import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdminDashboard } from '@/app/admin/page'
import { assessMedianCost, expectedStoryCost } from '@/lib/costs/expected'
import type { AdminMetrics } from '@/lib/admin/metrics'

/**
 * F12: the dashboard shows every metric the feature scope names, and shows the kill switch
 * and budget cap READ-ONLY (they are env-controlled). This renders the real component, so a
 * missing panel or a crash on a null metric fails here rather than in front of the owner.
 */

function metrics(overrides: Partial<AdminMetrics> = {}): AdminMetrics {
  const writer = 'claude-sonnet-5'
  const median = expectedStoryCost(writer).totalUsd
  return {
    generatedAt: '2026-09-27T12:00:00.000Z',
    controls: {
      generationEnabled: true,
      dailyBudgetUsd: 5,
      dailyStoryLimit: 3,
      writerModel: writer,
      helperModel: 'claude-haiku-4-5-20251001',
    },
    budget: { limitUsd: 5, spentUsd: 1.25, remainingUsd: 3.75, exceeded: false, calls: 40, failedCalls: 1, day: '2026-09-27' },
    today: {
      day: '2026-09-27',
      stories: 10,
      flagged: 1,
      failed: 0,
      calls: 40,
      failedCalls: 1,
      costUsd: 0.71,
      costPerStoryUsd: 0.071,
    },
    recent: [
      { day: '2026-09-27', stories: 10, flagged: 1, failed: 0, calls: 40, failedCalls: 1, costUsd: 0.71, costPerStoryUsd: 0.071 },
      { day: '2026-09-26', stories: 4, flagged: 0, failed: 0, calls: 16, failedCalls: 0, costUsd: 0.28, costPerStoryUsd: 0.07 },
    ],
    cost: {
      medianCostUsd: median,
      p95CostUsd: median * 1.4,
      avgCostUsd: median,
      storiesWithLogs: 14,
      totalCostUsd: 0.99,
      medianIncludingZeroCostUsd: 0,
      writeCacheReadRatio: 0.93,
      sanity: assessMedianCost(median, writer),
      expectedBreakdown: expectedStoryCost(writer).breakdown,
    },
    byWriter: [
      {
        model: writer,
        stories: 14,
        medianCostUsd: median,
        p95CostUsd: median * 1.4,
        avgCostUsd: median,
        sanity: assessMedianCost(median, writer),
      },
    ],
    stories: { total: 14, flagged: 1, failed: 0, flaggedRate: 1 / 14, total30d: 14, flaggedRate30d: 1 / 14 },
    factPacks: {
      stories: 10,
      hits: 8,
      hitRate: 0.8,
      recent: [{ day: '2026-09-27', stories: 10, hits: 8, hitRate: 0.8 }],
    },
    latency: [
      { purpose: 'write', calls: 14, failedCalls: 0, avgLatencyMs: 18_400, p95LatencyMs: 26_000, costUsd: 0.75, cacheReadRatio: 0.93 },
      { purpose: 'quality', calls: 14, failedCalls: 0, avgLatencyMs: 1_900, p95LatencyMs: 3_100, costUsd: 0.1, cacheReadRatio: 0 },
    ],
    topTopics: [{ topicKey: 'history-of-lego', topicLabel: 'The history of LEGO', useCount: 7, qualityScore: 4.5 }],
    errors: [],
    ...overrides,
  }
}

function render(m: AdminMetrics): string {
  return renderToStaticMarkup(AdminDashboard({ metrics: m }))
}

describe('F12 admin dashboard rendering', () => {
  it('shows every metric the F12 scope names', () => {
    const html = render(metrics())
    for (const label of [
      'Stories today',
      'Cost today',
      'Median cost / story',
      'p95 cost / story',
      'Write cache-read ratio',
      'Fact-pack hit rate',
      'Flagged-story rate',
      'Budget remaining today',
      'Top topics',
      'Latency and spend by call purpose',
    ]) {
      expect(html, `missing panel: ${label}`).toContain(label)
    }
    // The measured values themselves, not just the labels.
    expect(html).toContain('80.0%') // fact-pack hit rate
    expect(html).toContain('93.0%') // cache-read ratio
    expect(html).toContain('$3.7500') // budget remaining
    expect(html).toContain('history-of-lego')
    expect(html).toContain('18.4s') // average write latency
  })

  /** F12 scope: "Kill switch and budget cap are read-only here (env-controlled) but displayed." */
  it('displays the kill switch and budget cap read-only, with no form control', () => {
    const html = render(metrics())
    expect(html).toContain('GENERATION_ENABLED=true')
    expect(html).toContain('DAILY_BUDGET_USD=$5')
    expect(html).toContain('Read-only, env-controlled')
    // Nothing on this page can change them.
    expect(html).not.toMatch(/<(form|input|button|select|textarea)\b/)
  })

  it('shows the kill switch as off when it is off', () => {
    const html = render(metrics({ ...metrics(), controls: { ...metrics().controls, generationEnabled: false } }))
    expect(html).toContain('GENERATION_ENABLED=false')
  })

  it('says PAUSED when the budget is spent', () => {
    const m = metrics()
    const html = render({
      ...m,
      budget: { ...m.budget, spentUsd: 6, remainingUsd: 0, exceeded: true },
    })
    expect(html).toContain('PAUSED')
  })

  /**
   * The lane brief's rule: if the median is wildly outside the expected band, SAY SO rather
   * than shipping the number.
   */
  it('warns when the median cost per story is outside the expected band', () => {
    const m = metrics()
    const bad = 0.5
    const html = render({
      ...m,
      cost: { ...m.cost, medianCostUsd: bad, sanity: assessMedianCost(bad, 'claude-sonnet-5') },
    })
    expect(html).toContain('Median cost per story is above band')
    expect(html).toContain('runaway prompt')
  })

  it('renders cleanly with no data at all', () => {
    const empty = metrics({
      today: null,
      recent: [],
      byWriter: [],
      latency: [],
      topTopics: [],
      factPacks: { stories: 0, hits: 0, hitRate: null, recent: [] },
      stories: { total: 0, flagged: 0, failed: 0, flaggedRate: null, total30d: 0, flaggedRate30d: null },
      cost: {
        medianCostUsd: null,
        p95CostUsd: null,
        avgCostUsd: null,
        storiesWithLogs: 0,
        totalCostUsd: 0,
        medianIncludingZeroCostUsd: null,
        writeCacheReadRatio: null,
        sanity: assessMedianCost(null, 'claude-sonnet-5'),
        expectedBreakdown: expectedStoryCost('claude-sonnet-5').breakdown,
      },
    })
    const html = render(empty)
    expect(html).toContain('No data yet.')
    expect(html).toContain('—')
    // A missing metric must never render as a confident zero.
    expect(html).not.toContain('Median cost per story is')
  })

  it('surfaces a view read failure instead of rendering a silent zero', () => {
    const html = render(metrics({ errors: ['v_cost_summary: permission denied'] }))
    expect(html).toContain('Some panels could not be read')
    expect(html).toContain('v_cost_summary: permission denied')
  })
})
