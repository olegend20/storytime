import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { budgetStatus, type BudgetStatus } from '@/lib/costs/budget'
import { assessMedianCost, expectedStoryCost, type CostSanity } from '@/lib/costs/expected'
import { modelForRole } from '@/lib/ai/pricing'
import { dailyBudgetUsd, generationEnabled } from '@/lib/limits/switches'
import { DAILY_STORY_LIMIT } from '@/lib/schemas/api'

/**
 * F12 AC: "All numbers are computed from `generation_logs` and `stories` with SQL views, not
 * from application memory." Every field below is a straight read of a `v_*` view — there is
 * no accumulator in this process, so a cold start loses nothing and two lambdas cannot
 * disagree. The only things computed here are ratios of two view columns and the comparison
 * against the expected cost derived from `config/pricing.json`.
 *
 * Reads use the service role: `generation_logs` is service-role-only by design (§3), and
 * migration 20260927000005 revokes the cost views from anon/authenticated. The owner-gated
 * /admin page is the only caller.
 */

const RECENT_DAYS = 14

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
function int(v: unknown): number {
  return Math.round(num(v) ?? 0)
}
type Row = Record<string, unknown>

export interface DailyRow {
  day: string
  stories: number
  flagged: number
  failed: number
  calls: number
  failedCalls: number
  costUsd: number
  /** Cost / stories for that day. Null when the day had no stories. */
  costPerStoryUsd: number | null
}

export interface LatencyRow {
  purpose: string
  calls: number
  failedCalls: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  costUsd: number
  cacheReadRatio: number | null
}

export interface WriterCostRow {
  model: string
  stories: number
  medianCostUsd: number | null
  p95CostUsd: number | null
  avgCostUsd: number | null
  /** The §5 expected median for this model, and whether the measured one is near it. */
  sanity: CostSanity
}

export interface TopicRow {
  topicKey: string
  topicLabel: string
  useCount: number
  qualityScore: number | null
}

export interface FactPackDailyRow {
  day: string
  stories: number
  hits: number
  hitRate: number | null
}

export interface AdminMetrics {
  generatedAt: string
  /** Read-only on the page: both switches are env-controlled (F12 scope). */
  controls: {
    generationEnabled: boolean
    dailyBudgetUsd: number
    dailyStoryLimit: number
    writerModel: string
    helperModel: string
  }
  budget: BudgetStatus
  today: DailyRow | null
  recent: DailyRow[]
  cost: {
    /** Median/p95 over stories that have log rows (`v_story_cost_summary`). */
    medianCostUsd: number | null
    p95CostUsd: number | null
    avgCostUsd: number | null
    storiesWithLogs: number
    totalCostUsd: number
    /** `v_cost_summary`'s median, which counts log-less story rows at $0. Shown for contrast. */
    medianIncludingZeroCostUsd: number | null
    /** Cache-read share of writing-call input tokens. §5 target ≥ 0.90. */
    writeCacheReadRatio: number | null
    sanity: CostSanity
    expectedBreakdown: Record<string, number>
  }
  byWriter: WriterCostRow[]
  stories: {
    total: number
    flagged: number
    failed: number
    flaggedRate: number | null
    total30d: number
    flaggedRate30d: number | null
  }
  factPacks: {
    stories: number
    hits: number
    hitRate: number | null
    recent: FactPackDailyRow[]
  }
  latency: LatencyRow[]
  topTopics: TopicRow[]
  /** Anything that could not be read. The page still renders — a blank /admin is worse. */
  errors: string[]
}

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

export async function loadAdminMetrics(client?: SupabaseClient): Promise<AdminMetrics> {
  const db = client ?? supabaseService()
  const errors: string[] = []
  const since = utcDayKey(new Date(Date.now() - RECENT_DAYS * 86_400_000))

  /** One view read. A failure is recorded and the page renders without that panel. */
  async function view(label: string, run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<Row[]> {
    try {
      const { data, error } = await run()
      if (error) throw new Error((error as { message?: string }).message ?? String(error))
      return (data ?? []) as Row[]
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  const emptyBudget: BudgetStatus = {
    limitUsd: dailyBudgetUsd(),
    spentUsd: 0,
    remainingUsd: dailyBudgetUsd(),
    exceeded: false,
    calls: 0,
    failedCalls: 0,
    day: null,
  }

  const [
    budget,
    dailyCosts,
    dailyStories,
    storyCostSummary,
    costSummary,
    storyHealth,
    factPackAll,
    factPackDaily,
    latency,
    byWriterRows,
    topics,
  ] = await Promise.all([
    budgetStatus(db).catch((err: unknown) => {
      errors.push(`v_budget_today: ${err instanceof Error ? err.message : String(err)}`)
      return emptyBudget
    }),
    view('v_daily_costs', () =>
      db.from('v_daily_costs').select('day, calls, failed_calls, cost_usd').gte('day', since),
    ),
    view('v_daily_stories', () =>
      db.from('v_daily_stories').select('day, stories, flagged, failed').gte('day', since),
    ),
    view('v_story_cost_summary', () =>
      db.from('v_story_cost_summary').select('stories_with_logs, median_cost_usd, p95_cost_usd, avg_cost_usd'),
    ),
    view('v_cost_summary', () =>
      db.from('v_cost_summary').select('median_cost_usd, p95_cost_usd, total_cost_usd, write_cache_read_ratio'),
    ),
    view('v_story_health', () =>
      db.from('v_story_health').select('stories, flagged, failed, flagged_rate, stories_30d, flagged_rate_30d'),
    ),
    view('v_fact_pack_hit_rate', () => db.from('v_fact_pack_hit_rate').select('stories, hits, hit_rate')),
    view('v_fact_pack_hit_rate_daily', () =>
      db.from('v_fact_pack_hit_rate_daily').select('day, stories, hits, hit_rate').gte('day', since),
    ),
    view('v_latency_summary', () =>
      db
        .from('v_latency_summary')
        .select('purpose, calls, failed_calls, avg_latency_ms, p95_latency_ms, cost_usd, cache_read_ratio'),
    ),
    view('v_story_cost_by_writer', () =>
      db.from('v_story_cost_by_writer').select('model, stories, median_cost_usd, p95_cost_usd, avg_cost_usd'),
    ),
    view('v_top_topics', () =>
      db.from('v_top_topics').select('topic_key, topic_label, use_count, quality_score').limit(10),
    ),
  ])

  // ---- Join the two per-day views on `day`; either side may be missing a day.
  const byDay = new Map<string, DailyRow>()
  const dayRow = (day: string): DailyRow => {
    let r = byDay.get(day)
    if (!r) {
      r = { day, stories: 0, flagged: 0, failed: 0, calls: 0, failedCalls: 0, costUsd: 0, costPerStoryUsd: null }
      byDay.set(day, r)
    }
    return r
  }
  for (const c of dailyCosts) {
    const r = dayRow(String(c.day))
    r.calls = int(c.calls)
    r.failedCalls = int(c.failed_calls)
    r.costUsd = num(c.cost_usd) ?? 0
  }
  for (const s of dailyStories) {
    const r = dayRow(String(s.day))
    r.stories = int(s.stories)
    r.flagged = int(s.flagged)
    r.failed = int(s.failed)
  }
  for (const r of byDay.values()) {
    r.costPerStoryUsd = r.stories > 0 ? Math.round((r.costUsd / r.stories) * 1e6) / 1e6 : null
  }
  const recent = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1))

  const scs = storyCostSummary[0] ?? {}
  const cs = costSummary[0] ?? {}
  const sh = storyHealth[0] ?? {}
  const fp = factPackAll[0] ?? {}

  const medianCostUsd = num(scs.median_cost_usd)
  const writerModel = modelForRole('writer')

  return {
    generatedAt: new Date().toISOString(),
    controls: {
      generationEnabled: generationEnabled(),
      dailyBudgetUsd: dailyBudgetUsd(),
      dailyStoryLimit: DAILY_STORY_LIMIT,
      writerModel,
      helperModel: modelForRole('helper'),
    },
    budget,
    today: byDay.get(utcDayKey()) ?? null,
    recent,
    cost: {
      medianCostUsd,
      p95CostUsd: num(scs.p95_cost_usd),
      avgCostUsd: num(scs.avg_cost_usd),
      storiesWithLogs: int(scs.stories_with_logs),
      totalCostUsd: num(cs.total_cost_usd) ?? 0,
      medianIncludingZeroCostUsd: num(cs.median_cost_usd),
      writeCacheReadRatio: num(cs.write_cache_read_ratio),
      sanity: assessMedianCost(medianCostUsd, writerModel),
      expectedBreakdown: expectedStoryCost(writerModel).breakdown,
    },
    byWriter: byWriterRows.map((r) => ({
      model: String(r.model),
      stories: int(r.stories),
      medianCostUsd: num(r.median_cost_usd),
      p95CostUsd: num(r.p95_cost_usd),
      avgCostUsd: num(r.avg_cost_usd),
      // Compared against that model's OWN expected median, so a bake-off run reads correctly.
      sanity: assessMedianCost(num(r.median_cost_usd), String(r.model)),
    })),
    stories: {
      total: int(sh.stories),
      flagged: int(sh.flagged),
      failed: int(sh.failed),
      flaggedRate: num(sh.flagged_rate),
      total30d: int(sh.stories_30d),
      flaggedRate30d: num(sh.flagged_rate_30d),
    },
    factPacks: {
      stories: int(fp.stories),
      hits: int(fp.hits),
      hitRate: num(fp.hit_rate),
      recent: factPackDaily
        .map((d) => ({
          day: String(d.day),
          stories: int(d.stories),
          hits: int(d.hits),
          hitRate: num(d.hit_rate),
        }))
        .sort((a, b) => (a.day < b.day ? 1 : -1)),
    },
    latency: latency
      .map((l) => ({
        purpose: String(l.purpose),
        calls: int(l.calls),
        failedCalls: int(l.failed_calls),
        avgLatencyMs: num(l.avg_latency_ms),
        p95LatencyMs: num(l.p95_latency_ms),
        costUsd: num(l.cost_usd) ?? 0,
        cacheReadRatio: num(l.cache_read_ratio),
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    topTopics: topics.map((t) => ({
      topicKey: String(t.topic_key),
      topicLabel: String(t.topic_label),
      useCount: int(t.use_count),
      qualityScore: num(t.quality_score),
    })),
    errors,
  }
}
