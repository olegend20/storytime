import type { Metadata } from 'next'
import { requireOwner } from '@/lib/admin/gate'
import { loadAdminMetrics, type AdminMetrics } from '@/lib/admin/metrics'

/**
 * F12 — owner-only cost and health dashboard.
 *
 * Non-owners get a 404 from `requireOwner()` (never a 403: the page must not reveal that it
 * exists). Every number on it is read from a SQL view; nothing is accumulated in memory.
 */

export const metadata: Metadata = { title: 'StoryTime ops', robots: { index: false, follow: false } }
export const dynamic = 'force-dynamic'
export const revalidate = 0

// ---------------------------------------------------------------- formatting
const usd = (v: number | null | undefined, dp = 4): string =>
  v === null || v === undefined ? '—' : `$${v.toFixed(dp)}`
const pct = (v: number | null | undefined, dp = 1): string =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(dp)}%`
const ms = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`
const n = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'))

// ---------------------------------------------------------------- primitives
function Card({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  const toneClass = {
    neutral: 'border-black/10 dark:border-white/15',
    good: 'border-emerald-500/40',
    warn: 'border-amber-500/50',
    bad: 'border-rose-500/50',
  }[tone]
  return (
    <div className={`rounded-lg border bg-black/[0.02] p-4 dark:bg-white/[0.04] ${toneClass}`}>
      <div className="text-xs font-medium uppercase tracking-wide opacity-60">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-1 text-xs opacity-60">{sub}</div> : null}
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">{title}</h2>
      {note ? <p className="mt-1 text-xs opacity-55">{note}</p> : null}
      <div className="mt-3 overflow-x-auto">{children}</div>
    </section>
  )
}

function Table({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) {
    return <p className="text-sm opacity-55">No data yet.</p>
  }
  return (
    <table className="w-full min-w-[32rem] border-collapse text-sm">
      <thead>
        <tr className="border-b border-black/10 text-left dark:border-white/15">
          {head.map((h, i) => (
            <th key={h} className={`py-2 pr-4 text-xs font-medium uppercase tracking-wide opacity-60 ${i > 0 ? 'text-right' : ''}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-b border-black/5 dark:border-white/10">
            {r.map((cell, ci) => (
              <td key={ci} className={`py-2 pr-4 tabular-nums ${ci > 0 ? 'text-right' : 'font-medium'}`}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------- page
export default async function AdminPage() {
  await requireOwner()
  const m = await loadAdminMetrics()
  return <AdminDashboard metrics={m} />
}

export function AdminDashboard({ metrics: m }: { metrics: AdminMetrics }) {
  const budgetTone = m.budget.exceeded ? 'bad' : m.budget.remainingUsd < m.budget.limitUsd * 0.2 ? 'warn' : 'good'
  const cacheTone =
    m.cost.writeCacheReadRatio === null ? 'neutral' : m.cost.writeCacheReadRatio >= 0.9 ? 'good' : 'warn'
  const hitTone = m.factPacks.hitRate === null ? 'neutral' : m.factPacks.hitRate >= 0.8 ? 'good' : 'warn'
  const medianTone =
    m.cost.sanity.verdict === 'no-data'
      ? 'neutral'
      : m.cost.sanity.verdict === 'in-band'
        ? 'good'
        : m.cost.sanity.verdict === 'above-band'
          ? 'bad'
          : 'warn'

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">StoryTime ops</h1>
        <p className="text-xs opacity-55">
          All figures from SQL views over <code>generation_logs</code> and <code>stories</code> ·{' '}
          {new Date(m.generatedAt).toISOString().replace('T', ' ').slice(0, 19)}Z
        </p>
      </header>

      {/* Env-controlled switches. Read-only here by design (F12 scope). */}
      <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-black/10 p-3 text-xs dark:border-white/15">
        <span className="opacity-60">Read-only, env-controlled:</span>
        <span
          className={`rounded-full px-2 py-0.5 font-medium ${
            m.controls.generationEnabled
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
          }`}
        >
          GENERATION_ENABLED={String(m.controls.generationEnabled)}
        </span>
        <span className="rounded-full bg-black/5 px-2 py-0.5 font-medium dark:bg-white/10">
          DAILY_BUDGET_USD=${m.controls.dailyBudgetUsd}
        </span>
        <span className="rounded-full bg-black/5 px-2 py-0.5 font-medium dark:bg-white/10">
          {m.controls.dailyStoryLimit} stories/family/day
        </span>
        <span className="rounded-full bg-black/5 px-2 py-0.5 font-medium dark:bg-white/10">
          writer: {m.controls.writerModel}
        </span>
        <span className="rounded-full bg-black/5 px-2 py-0.5 font-medium dark:bg-white/10">
          helper: {m.controls.helperModel}
        </span>
      </div>

      {m.errors.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
          <strong>Some panels could not be read:</strong>
          <ul className="mt-1 list-inside list-disc">
            {m.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ---------------- headline numbers ---------------- */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Card
          label="Budget remaining today"
          value={usd(m.budget.remainingUsd, 4)}
          sub={`${usd(m.budget.spentUsd, 4)} of $${m.budget.limitUsd} spent${m.budget.exceeded ? ' — PAUSED' : ''}`}
          tone={budgetTone}
        />
        <Card
          label="Stories today"
          value={n(m.today?.stories ?? 0)}
          sub={`${n(m.today?.calls ?? m.budget.calls)} model calls, ${n(m.today?.failedCalls ?? m.budget.failedCalls)} failed`}
        />
        <Card
          label="Cost today"
          value={usd(m.today?.costUsd ?? m.budget.spentUsd, 4)}
          sub={m.today?.costPerStoryUsd !== null && m.today?.costPerStoryUsd !== undefined ? `${usd(m.today.costPerStoryUsd)} per story` : 'no stories yet today'}
        />
        <Card
          label="Median cost / story"
          value={usd(m.cost.medianCostUsd)}
          sub={`expected ${usd(m.cost.sanity.expectedUsd)} · band ${usd(m.cost.sanity.minUsd)}–${usd(m.cost.sanity.maxUsd)}`}
          tone={medianTone}
        />
        <Card label="p95 cost / story" value={usd(m.cost.p95CostUsd)} sub={`over ${n(m.cost.storiesWithLogs)} logged stories`} />
        <Card
          label="Write cache-read ratio"
          value={pct(m.cost.writeCacheReadRatio)}
          sub="§5 target ≥ 90% of master-prompt tokens"
          tone={cacheTone}
        />
        <Card
          label="Fact-pack hit rate"
          value={pct(m.factPacks.hitRate)}
          sub={`${n(m.factPacks.hits)} of ${n(m.factPacks.stories)} stories · target ≥ 80%`}
          tone={hitTone}
        />
        <Card
          label="Flagged-story rate"
          value={pct(m.stories.flaggedRate)}
          sub={`${n(m.stories.flagged)} flagged, ${n(m.stories.failed)} failed of ${n(m.stories.total)}`}
          tone={m.stories.flaggedRate !== null && m.stories.flaggedRate > 0.1 ? 'warn' : 'neutral'}
        />
      </div>

      {m.cost.sanity.verdict === 'above-band' || m.cost.sanity.verdict === 'below-band' ? (
        <p className="mt-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs">
          <strong>Median cost per story is {m.cost.sanity.verdict.replace('-', ' ')}.</strong> The §5 token
          model predicts {usd(m.cost.sanity.expectedUsd)} for {m.controls.writerModel}; measured{' '}
          {usd(m.cost.medianCostUsd)}. Check the token mix in <code>v_latency_summary</code> before trusting
          this number — a runaway prompt, a regeneration loop, or story history leaking into context all land
          here. Note that Haiku 4.5 tokenizes ~30% shorter than Sonnet 5 / Opus 5.5 / Fable 5.1, so its
          measured median sits legitimately below the estimate.
        </p>
      ) : null}

      {/* ---------------- per day ---------------- */}
      <Section
        title="Last 14 days"
        note="v_daily_costs joined to v_daily_stories on day (database day, UTC)."
      >
        <Table
          head={['Day', 'Stories', 'Flagged', 'Calls', 'Failed', 'Cost', 'Cost/story']}
          rows={m.recent.map((d) => [
            d.day,
            n(d.stories),
            n(d.flagged),
            n(d.calls),
            n(d.failedCalls),
            usd(d.costUsd),
            usd(d.costPerStoryUsd),
          ])}
        />
      </Section>

      {/* ---------------- per writing model ---------------- */}
      <Section
        title="Cost per story by writing model"
        note="v_story_cost_by_writer. Measured from logged tokens, never from word-count estimates — the models do not share a tokenizer."
      >
        <Table
          head={['Model', 'Stories', 'Median', 'p95', 'Mean', 'Expected', 'Verdict']}
          rows={m.byWriter.map((w) => [
            w.model,
            n(w.stories),
            usd(w.medianCostUsd),
            usd(w.p95CostUsd),
            usd(w.avgCostUsd),
            usd(w.sanity.expectedUsd),
            w.sanity.verdict,
          ])}
        />
      </Section>

      {/* ---------------- latency + where the money goes ---------------- */}
      <Section title="Latency and spend by call purpose" note="v_latency_summary.">
        <Table
          head={['Purpose', 'Calls', 'Failed', 'Avg', 'p95', 'Cost', 'Cache read']}
          rows={m.latency.map((l) => [
            l.purpose,
            n(l.calls),
            n(l.failedCalls),
            ms(l.avgLatencyMs),
            ms(l.p95LatencyMs),
            usd(l.costUsd),
            pct(l.cacheReadRatio),
          ])}
        />
      </Section>

      {/* ---------------- fact pack trend ---------------- */}
      <Section
        title="Fact-pack hit rate by day"
        note="v_fact_pack_hit_rate_daily. A hit is a story reusing a pack that already existed."
      >
        <Table
          head={['Day', 'Stories', 'Hits', 'Hit rate']}
          rows={m.factPacks.recent.map((d) => [d.day, n(d.stories), n(d.hits), pct(d.hitRate)])}
        />
      </Section>

      {/* ---------------- topics ---------------- */}
      <Section title="Top topics" note="v_top_topics, by fact-pack use_count.">
        <Table
          head={['Topic', 'Uses', 'Quality', 'Key']}
          rows={m.topTopics.map((t) => [t.topicLabel, n(t.useCount), t.qualityScore?.toFixed(2) ?? '—', t.topicKey])}
        />
      </Section>

      {/* ---------------- expected cost model ---------------- */}
      <Section
        title="Expected cost per story"
        note={`Derived from the IMPLEMENTATION_PLAN §5 token table and config/pricing.json for ${m.controls.writerModel} + ${m.controls.helperModel}. Not a measurement — the yardstick the median above is judged against.`}
      >
        <Table
          head={['Step', 'Expected cost']}
          rows={[
            ...Object.entries(m.cost.expectedBreakdown).map(([step, cost]) => [step, usd(cost)]),
            ['total', usd(m.cost.sanity.expectedUsd)],
          ]}
        />
      </Section>

      <p className="mt-8 text-xs opacity-50">
        All-time spend {usd(m.cost.totalCostUsd, 4)}. Median including story rows with no log rows:{' '}
        {usd(m.cost.medianIncludingZeroCostUsd)} (v_cost_summary) — the headline median above excludes them.
      </p>
    </main>
  )
}
