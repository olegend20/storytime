import { capabilities, computeCost, modelForRole, pricing, type GenerationLogSink } from '@/lib/ai'
import { loadPrompt } from '@/lib/prompts'
import { runDeterministicChecks } from '@/lib/quality/deterministic'
import { measuredForReview, reviewPassed, reviewVerdictFailures, runQualityReview } from '@/lib/quality/review'
import { MAX_SCARY_LEVEL, targetWords, type FactPack, type GenerationRequest, type QualityReview, type StoryOutput } from '@/lib/schemas'
import type { CostEstimate } from './estimate'

/**
 * The quality-reviewer bench (issue #58). The 32-story eval on #40 sent 26 of 30 first drafts
 * back; four because the reviewer's own JSON did not validate, many because it failed a word
 * the story had explained. A full eval costs ~$15 to tell one reviewer prompt from another;
 * this replays only the reviewer, on a frozen set of first drafts, for well under $1.
 *
 * The set is built once (`--build`): each golden-set scenario written through the production
 * pipeline and stopped at the gate (`firstDraftOnly`). Each draft is then labelled by hand:
 * should the reviewer pass it? A candidate prompt is scored on:
 *   - format failures: answers that did not validate (target 0);
 *   - wrong fails: failing a draft labelled `should_pass` (down);
 *   - catches: failing a draft labelled not `should_pass` (must not drop);
 *   - flips: drafts whose verdict differs between samples (down).
 * The verdict is the reviewer's alone (`reviewPassed`): the gate's deterministic checks and
 * the safety review are not part of what is being tuned.
 *
 * The same run scores the WRITER that made the set (DECISIONS #202): how many first drafts
 * the reviewer passes, which judgement fails the rest, and the gate's free deterministic
 * checks. A candidate writer prompt is a new set built with it, scored by a fixed reviewer.
 */

export interface BenchItem {
  id: string
  scenario_id: string
  story: StoryOutput
  request: GenerationRequest
  fact_pack: FactPack
}

export interface BenchSet {
  kind: 'review-bench-set'
  created_at: string
  writer_model: string
  /** The writer prompt the drafts were written with; absent on sets built before #202. */
  writer_prompt?: { id: string; version: number }
  build_cost_usd: number
  items: BenchItem[]
}

/** A hand label: would a careful editor pass this draft on the reviewer's five judgements? */
export interface BenchLabel {
  id: string
  should_pass: boolean
  /** What is really wrong, when `should_pass` is false; what the reviewer gets wrong otherwise. */
  notes: string
}

export interface BenchReview {
  item_id: string
  sample: number
  valid: boolean
  passed: boolean
  failures: string[]
  /** The review's judgements that failed, by field name (#202). */
  failed_checks?: string[]
  reasons: string[]
  /** Kept only when the answer did not validate, so the cause can be read. */
  raw_text?: string
  cost_usd: number
}

export interface ReviewerSettings {
  model?: string
  effort?: 'low' | 'medium' | 'high'
  thinking?: 'adaptive' | 'off'
}

export interface BenchSummary {
  calls: number
  format_failures: number
  wrong_fails: { count: number; of: number }
  catches: { count: number; of: number }
  flips: { count: number; of: number }
  longest_reason: number
  cost_usd: number
  /** The writer's view (#202): reviews that passed, and how often each judgement failed. */
  passes?: { count: number; of: number }
  by_check?: Record<string, number>
  /** Drafts that pass the gate's deterministic checks, and the checks that failed. */
  deterministic?: { passed: number; of: number; by_check: Record<string, number> }
}

export interface BenchRun {
  kind: 'review-bench-run'
  ran_at: string
  set: string
  prompt: { id: string; version: number; dir: string }
  /** The reviewer model and its settings; the configured quality_reviewer when absent. */
  reviewer?: ReviewerSettings
  samples: number
  labelled: boolean
  summary: BenchSummary
  reviews: BenchReview[]
}

/**
 * Per-call tokens, measured on 2026-10-14: the writer's first draft (input from
 * `generation_logs`, #53; output 13,230-15,437 per write across the three 32-story runs) and
 * one quality review (v3's longer reasons run to ~560 output tokens).
 */
const WRITE_TOKENS = { input: 2_800, cacheRead: 7_000, output: 14_500 }
const REVIEW_TOKENS = { input: 7_200, output: 400 }

export function estimateBuildCost(drafts: number, writer: string = modelForRole('writer')): CostEstimate {
  const each = computeCost({ model: writer, input: WRITE_TOKENS.input, cacheRead: WRITE_TOKENS.cacheRead, output: WRITE_TOKENS.output })
  return {
    lines: [{ what: `write ${drafts} first drafts, stopped at the gate`, model: writer, calls: drafts, usd: each * drafts }],
    total_usd: each * drafts,
    pricing_updated_at: pricing.updated_at,
    assumptions: [
      `${WRITE_TOKENS.output.toLocaleString()} output tokens per write (thinking included), measured 2026-10-14.`,
      'Helper calls before the write (input guard) are a few tenths of a cent and not counted.',
      'A draft the writer cannot finish is retried once at a shorter length, as in production: not counted here.',
    ],
  }
}

/** A reviewer that thinks writes its thinking as output: budgeted generously, as it is cheap. */
const THINKING_OUTPUT_TOKENS = 3_000
/** Haiku 5.5's tokenizer counts the same text as ~30% more tokens than Haiku 4.5's. */
const NEW_TOKENIZER = 1.3

export function estimateRunCost(items: number, samples: number, reviewer: string = modelForRole('quality_reviewer'), settings: ReviewerSettings = {}): CostEstimate {
  const calls = items * samples
  const caps = capabilities(reviewer)
  const scale = caps.tokenizer === 'v4_7' ? NEW_TOKENIZER : 1
  const thinks = caps.thinking === 'adaptive_default_on' && settings.thinking !== 'off'
  const output = Math.round(REVIEW_TOKENS.output * scale) + (thinks ? THINKING_OUTPUT_TOKENS : 0)
  const each = computeCost({ model: reviewer, input: Math.round(REVIEW_TOKENS.input * scale), output })
  return {
    lines: [{ what: `review ${items} drafts × ${samples} samples`, model: reviewer, calls, usd: each * calls }],
    total_usd: each * calls,
    pricing_updated_at: pricing.updated_at,
    assumptions: [
      `${Math.round(REVIEW_TOKENS.input * scale).toLocaleString()} input and ${output.toLocaleString()} output tokens per review${thinks ? ' (thinking included)' : ''}.`,
    ],
  }
}

/** The review's judgements that failed, by field name: what a writer prompt is tuned against. */
export function failedChecks(review: QualityReview, band: GenerationRequest['age_band']): string[] {
  const out: string[] = []
  if (!review.age_appropriate) out.push('age_appropriate')
  if (review.scary_level > MAX_SCARY_LEVEL[band]) out.push('scary_level')
  if (!review.kids_are_active_participants) out.push('kids_are_active_participants')
  if (!review.facts_consistent_with_pack) out.push('facts_consistent_with_pack')
  if (!review.tone_matches_request) out.push('tone_matches_request')
  return out
}

/** The gate's deterministic checks on each draft: free, and the other half of a first-draft pass. */
export function deterministicSummary(items: readonly BenchItem[]): NonNullable<BenchSummary['deterministic']> {
  const by_check: Record<string, number> = {}
  let passed = 0
  for (const item of items) {
    const r = item.request
    const result = runDeterministicChecks({
      story: item.story,
      children: r.children.map((c) => ({ name: c.name, age: c.age })),
      band: r.age_band,
      minutes: r.length_minutes,
      targetWords: r.target_words ?? targetWords({ band: r.age_band, minutes: r.length_minutes }),
      factPack: item.fact_pack,
    })
    if (result.passed) passed += 1
    for (const check of new Set(result.failures.map((f) => f.check))) by_check[check] = (by_check[check] ?? 0) + 1
  }
  return { passed, of: items.length, by_check }
}

export function summarizeBench(
  reviews: readonly BenchReview[],
  labels: readonly BenchLabel[] | null,
  items?: readonly BenchItem[],
): BenchSummary {
  const byItem = new Map<string, BenchReview[]>()
  for (const r of reviews) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r])
  const label = new Map((labels ?? []).map((l) => [l.id, l]))

  let wrong = 0
  let wrongOf = 0
  let caught = 0
  let caughtOf = 0
  let flips = 0
  for (const [id, rs] of byItem) {
    if (new Set(rs.map((r) => r.passed)).size > 1) flips += 1
    const l = label.get(id)
    if (!l) continue
    for (const r of rs) {
      if (l.should_pass) {
        wrongOf += 1
        if (!r.passed) wrong += 1
      } else {
        caughtOf += 1
        if (!r.passed) caught += 1
      }
    }
  }
  return {
    calls: reviews.length,
    format_failures: reviews.filter((r) => !r.valid).length,
    wrong_fails: { count: wrong, of: wrongOf },
    catches: { count: caught, of: caughtOf },
    flips: { count: flips, of: byItem.size },
    longest_reason: Math.max(0, ...reviews.flatMap((r) => r.reasons.map((x) => x.length))),
    cost_usd: reviews.reduce((n, r) => n + r.cost_usd, 0),
    passes: { count: reviews.filter((r) => r.passed).length, of: reviews.length },
    by_check: reviews.reduce<Record<string, number>>((acc, r) => {
      for (const c of r.failed_checks ?? []) acc[c] = (acc[c] ?? 0) + 1
      return acc
    }, {}),
    ...(items ? { deterministic: deterministicSummary(items) } : {}),
  }
}

/** Run a candidate reviewer prompt over the set. Bounded concurrency; each call is one quality review. */
export async function runBench(
  set: BenchSet,
  opts: {
    promptDir?: string
    reviewer?: ReviewerSettings
    samples: number
    concurrency?: number
    sink?: GenerationLogSink
    onProgress?: (done: number, of: number) => void
  },
): Promise<{ prompt: { id: string; version: number }; reviews: BenchReview[] }> {
  const prompt = opts.promptDir ? loadPrompt('quality-review', opts.promptDir) : loadPrompt('quality-review')
  const jobs = set.items.flatMap((item) => Array.from({ length: opts.samples }, (_, i) => ({ item, sample: i + 1 })))
  const reviews: BenchReview[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const { item, sample } = jobs[next++]!
      const band = item.request.age_band
      const run = await runQualityReview(item.story, item.request, item.fact_pack, {
        systemPrompt: prompt.body,
        ...(opts.reviewer ?? {}),
        measured: measuredForReview(item.story, band),
        ...(opts.sink ? { sink: opts.sink } : {}),
      })
      reviews.push({
        item_id: item.id,
        sample,
        valid: run.valid,
        passed: reviewPassed(run.review, band),
        failures: reviewVerdictFailures(run.review, band),
        failed_checks: failedChecks(run.review, band),
        reasons: run.review.reasons,
        ...(run.valid ? {} : { raw_text: run.text }),
        cost_usd: run.costUsd,
      })
      opts.onProgress?.(reviews.length, jobs.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, jobs.length) }, worker))
  reviews.sort((a, b) => a.item_id.localeCompare(b.item_id) || a.sample - b.sample)
  return { prompt: { id: prompt.id, version: prompt.version }, reviews }
}

export function formatBench(run: BenchRun): string {
  const s = run.summary
  const pct = (n: number, of: number) => (of === 0 ? '-' : `${n}/${of} (${Math.round((100 * n) / of)}%)`)
  return [
    `review bench: ${run.prompt.id} v${run.prompt.version} (${run.prompt.dir}) on ${run.reviewer?.model ?? 'the quality reviewer'}` +
      `${run.reviewer?.effort ? `, effort ${run.reviewer.effort}` : ''}${run.reviewer?.thinking === 'off' ? ', thinking off' : ''}` +
      `, ${run.samples} sample(s), set ${run.set}`,
    `  format failures: ${pct(s.format_failures, s.calls)}`,
    `  wrong fails:     ${run.labelled ? pct(s.wrong_fails.count, s.wrong_fails.of) : 'no labels'}`,
    `  catches:         ${run.labelled ? pct(s.catches.count, s.catches.of) : 'no labels'}`,
    `  flips:           ${pct(s.flips.count, s.flips.of)}`,
    `  longest reason:  ${s.longest_reason} chars (schema limit 300)`,
    `  cost:            $${s.cost_usd.toFixed(4)}`,
    ...(s.passes
      ? [
          `  writer: reviewer passes ${pct(s.passes.count, s.passes.of)}` +
            `${Object.keys(s.by_check ?? {}).length ? `; fails by judgement: ${Object.entries(s.by_check ?? {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`,
        ]
      : []),
    ...(s.deterministic
      ? [
          `  writer: deterministic checks pass ${pct(s.deterministic.passed, s.deterministic.of)}` +
            `${Object.keys(s.deterministic.by_check).length ? `; failing: ${Object.entries(s.deterministic.by_check).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`,
        ]
      : []),
  ].join('\n')
}
