import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerationLogSink } from '@/lib/ai'
import {
  FactPack,
  QualityResult,
  StoryOutput,
  targetWords,
  type AgeBand,
  type LengthMinutes,
  type StoryBible,
} from '@/lib/schemas'
import type { AfterStreaming } from '@/lib/generate/after-streaming'
import type { EvalResult } from './harness'
import { JUDGE_PROMPT_FILE, loadJudgePrompt, scoreStory, type ScoreStoryResult } from './judge'
import { gateSummary } from './live-pipeline'
import type { JudgeContext } from './types'

/**
 * `pnpm eval:family` (issue #132): the books the owner's family made during the writer trial,
 * scored by the same judge, prompt and caps as `pnpm eval`, and set beside a Sonnet eval.
 *
 * The story route records each saved trial story in `story_evals` (`recordTrialStory`); this
 * module scores the rows that have no score yet and writes the score back. The judge is given
 * what `judgeContextFor` gives it for an eval scenario - the children, the band, the tones,
 * the length, the parent's topic, the bible before the story - and the caps get the saved
 * gate verdict and the fact pack, exactly as in `runEval`.
 *
 * What it is not: a paired comparison. The family's books are their own requests, the Sonnet
 * eval is the 32 golden scenarios, so the two means are of different stories. Same writer
 * pipeline, same judge, same rubric; different requests.
 *
 * Nothing here writes a file. The scores stay in the database with the story: the report
 * prints numbers and story ids, never the story's text or a name.
 */

export const CRITERIA = ['center', 'craft', 'facts', 'age_fit', 'continuity', 'delight'] as const
export type Criterion = (typeof CRITERIA)[number]

/** A `story_evals` row, as this module reads it. */
export interface FamilyEvalRow {
  story_id: string
  family_id: string
  writer_model: string
  master_prompt: string
  bible_before: StoryBible | null
  write_calls: number
  after_streaming: AfterStreaming
  first_draft_untouched: boolean
  created_at: string
  judged_at: string | null
  judge_model: string | null
  judge_prompt_sha: string | null
  judge_error: string | null
  scores: Record<string, number> | null
  overall_raw: number | null
  overall_final: number | null
  caps_applied: string[] | null
  disqualified: boolean | null
  judge_cost_usd: number | null
}

const ROW_COLUMNS =
  'story_id, family_id, writer_model, master_prompt, bible_before, write_calls, after_streaming, ' +
  'first_draft_untouched, created_at, judged_at, judge_model, judge_prompt_sha, judge_error, scores, ' +
  'overall_raw, overall_final, caps_applied, disqualified, judge_cost_usd'

function asRow(raw: unknown): FamilyEvalRow {
  const r = raw as FamilyEvalRow
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
  return { ...r, overall_raw: num(r.overall_raw), overall_final: num(r.overall_final), judge_cost_usd: num(r.judge_cost_usd) }
}

/** Recorded trial books, oldest first. `unjudgedOnly` is what a scoring run works through. */
export async function loadFamilyEvalRows(
  db: SupabaseClient,
  opts: { unjudgedOnly?: boolean; limit?: number; familyId?: string } = {},
): Promise<FamilyEvalRow[]> {
  let query = db.from('story_evals').select(ROW_COLUMNS).order('created_at', { ascending: true })
  if (opts.familyId) query = query.eq('family_id', opts.familyId)
  if (opts.unjudgedOnly) query = query.is('judged_at', null)
  if (opts.limit !== undefined) query = query.limit(opts.limit)
  const { data, error } = await query
  if (error) throw new Error(`story_evals read: ${error.message}`)
  return (data ?? []).map(asRow)
}

/**
 * A bible with nothing in it is a first story, and the eval's first-story scenarios give the
 * judge no bible at all (`bible: null`). The same here, so continuity is scored the same way.
 */
export function bibleForJudge(bible: StoryBible | null): StoryBible | null {
  if (!bible) return null
  const empty =
    bible.last_story === null &&
    bible.recurring.length === 0 &&
    bible.catchphrases.length === 0 &&
    bible.topics_covered.length === 0
  return empty ? null : bible
}

/** Everything `scoreStory` needs for one saved book. */
export interface FamilyBook {
  context: JudgeContext
  story: StoryOutput
  quality: QualityResult | null
  factPack: FactPack | null
}

/** Read one recorded book back from the database, as the judge and the caps need it. */
export async function loadFamilyBook(db: SupabaseClient, row: FamilyEvalRow): Promise<FamilyBook> {
  const { data: story, error } = await db
    .from('stories')
    .select('series_id, topic_input, tones, length_minutes, age_band, content, quality, fact_pack_id')
    .eq('id', row.story_id)
    .maybeSingle()
  if (error) throw new Error(`stories read: ${error.message}`)
  if (!story) throw new Error('the story is no longer in the database')
  const s = story as {
    series_id: string
    topic_input: string
    tones: string[]
    length_minutes: LengthMinutes
    age_band: AgeBand
    content: unknown
    quality: unknown
    fact_pack_id: string | null
  }

  const { data: series, error: seriesErr } = await db.from('series').select('child_ids').eq('id', s.series_id).maybeSingle()
  if (seriesErr) throw new Error(`series read: ${seriesErr.message}`)
  const childIds = ((series as { child_ids: string[] } | null)?.child_ids ?? []) as string[]
  const { data: children, error: childErr } = await db
    .from('children')
    .select('id, first_name, age, likes, notes')
    .eq('family_id', row.family_id)
    .in('id', childIds)
  if (childErr) throw new Error(`children read: ${childErr.message}`)
  const byId = new Map(((children ?? []) as { id: string; first_name: string; age: number; likes: string[] | null; notes: string | null }[]).map((c) => [c.id, c]))
  const cast = childIds.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => c !== undefined)
  if (cast.length === 0) throw new Error('the children this story was written for are no longer in the family')

  let factPack: FactPack | null = null
  if (s.fact_pack_id) {
    const { data: pack, error: packErr } = await db.from('fact_packs').select('content').eq('id', s.fact_pack_id).maybeSingle()
    if (packErr) throw new Error(`fact_packs read: ${packErr.message}`)
    const parsed = FactPack.safeParse((pack as { content: unknown } | null)?.content)
    factPack = parsed.success ? parsed.data : null
  }

  const quality = QualityResult.safeParse(s.quality)
  return {
    context: {
      children: cast.map((c) => ({ name: c.first_name, age: c.age, likes: c.likes ?? [], notes: c.notes })),
      age_band: s.age_band,
      tones: s.tones,
      length_minutes: s.length_minutes,
      target_words: targetWords({ band: s.age_band, minutes: s.length_minutes }),
      topic_label: s.topic_input,
      bible: bibleForJudge(row.bible_before),
      // As `judgeContextFor`: the judge is not shown the pack; the caps check the fact ids.
      fact_pack: null,
    },
    story: StoryOutput.parse(s.content),
    quality: quality.success ? quality.data : null,
    factPack,
  }
}

export type ScoreFn = typeof scoreStory

export interface FamilyEvalRunOptions {
  db: SupabaseClient
  /** The judge. Injected in tests; `scoreStory` in a real run. */
  score?: ScoreFn
  sink?: GenerationLogSink
  limit?: number
  /** Only this family's books. Unset is every recorded book (only the owner's are recorded). */
  familyId?: string
  now?: () => Date
  onProgress?: (line: string) => void
}

export interface FamilyEvalRun {
  scored: number
  errors: number
  costUsd: number
}

const ERROR_MAX = 500

/** The judge columns for one book: its scores, or why there are none. */
export function judgedColumns(result: ScoreStoryResult, now: Date): Record<string, unknown> {
  const prompt = loadJudgePrompt()
  const common = {
    judged_at: now.toISOString(),
    judge_model: result.model || null,
    judge_prompt: prompt.version,
    judge_prompt_sha: prompt.sha256,
    judge_cost_usd: Math.round(result.costUsd * 1e6) / 1e6,
  }
  if (!result.ok) return { ...common, judge_error: result.reason.slice(0, ERROR_MAX) }
  return {
    ...common,
    judge_error: null,
    scores: result.raw.scores,
    overall_raw: result.raw.overall,
    // What counts: the caps applied and the overall recomputed by our code, as in `runEval`.
    overall_final: result.final.overall,
    caps_applied: result.final.caps_applied,
    disqualified: result.final.disqualified,
  }
}

/**
 * Score every recorded book that has no score. A book the judge cannot score (it will not
 * parse, the blind check trips on a word, the story was deleted) gets `judge_error` on its
 * row and the run carries on: it is not retried by the next run, so a broken book cannot be
 * paid for every night.
 */
export async function runFamilyEval(opts: FamilyEvalRunOptions): Promise<FamilyEvalRun> {
  const score = opts.score ?? scoreStory
  const now = opts.now ?? (() => new Date())
  const say = opts.onProgress ?? (() => {})
  const rows = await loadFamilyEvalRows(opts.db, {
    unjudgedOnly: true,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.familyId ? { familyId: opts.familyId } : {}),
  })
  const run: FamilyEvalRun = { scored: 0, errors: 0, costUsd: 0 }

  for (const row of rows) {
    say(`score ${row.story_id} (${row.writer_model}, ${row.master_prompt})`)
    let columns: Record<string, unknown>
    try {
      const book = await loadFamilyBook(opts.db, row)
      const result = await score({
        context: book.context,
        story: book.story,
        gate: gateSummary(book.quality),
        factPack: book.factPack,
        ...(opts.sink ? { sink: opts.sink } : {}),
        // Not the story's id: the judge's cost is the trial's, and must not be added to what
        // the story cost to make (`v_story_costs` sums a story's log rows).
        storyId: null,
        familyId: null,
      })
      columns = judgedColumns(result, now())
      run.costUsd += result.costUsd
      if (result.ok) run.scored += 1
      else run.errors += 1
    } catch (err) {
      const prompt = loadJudgePrompt()
      columns = {
        judged_at: now().toISOString(),
        judge_prompt: prompt.version,
        judge_prompt_sha: prompt.sha256,
        judge_error: `not scored: ${err instanceof Error ? err.message : String(err)}`.slice(0, ERROR_MAX),
      }
      run.errors += 1
    }
    if (columns.judge_error) say(`  no score: ${String(columns.judge_error)}`)
    const { error } = await opts.db.from('story_evals').update(columns).eq('story_id', row.story_id)
    if (error) throw new Error(`story_evals write for ${row.story_id}: ${error.message}`)
  }
  return run
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** The numbers both sides of the comparison are reduced to. */
export interface ComparableSummary {
  label: string
  stories: number
  scored: number
  judge_errors: number
  mean_overall: number | null
  min_overall: number | null
  disqualified: number
  criterion_means: Partial<Record<Criterion, number>>
  first_draft: { passed: number; of: number } | null
  after_streaming: { unchanged: number; edited: number; replaced: number; of: number } | null
}

const mean = (values: number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length)

/** The trial's books. Unscored rows count as stories, not as scores. */
export function summarizeFamilyRows(rows: readonly FamilyEvalRow[], label: string): ComparableSummary {
  const scored = rows.filter((r) => r.overall_final !== null && r.scores !== null)
  const criterion_means: Partial<Record<Criterion, number>> = {}
  for (const c of CRITERIA) {
    const m = mean(scored.map((r) => r.scores![c]).filter((v): v is number => typeof v === 'number'))
    if (m !== null) criterion_means[c] = m
  }
  const overall = scored.map((r) => r.overall_final!)
  return {
    label,
    stories: rows.length,
    scored: scored.length,
    judge_errors: rows.filter((r) => r.judge_error !== null).length,
    mean_overall: mean(overall),
    min_overall: overall.length === 0 ? null : Math.min(...overall),
    disqualified: scored.filter((r) => r.disqualified === true).length,
    criterion_means,
    first_draft: { passed: rows.filter((r) => r.first_draft_untouched).length, of: rows.length },
    after_streaming: {
      unchanged: rows.filter((r) => r.after_streaming === 'unchanged').length,
      edited: rows.filter((r) => r.after_streaming === 'edited').length,
      replaced: rows.filter((r) => r.after_streaming === 'replaced').length,
      of: rows.length,
    },
  }
}

/** A `pnpm eval` result file, reduced to the same numbers. */
export function summarizeBaseline(baseline: EvalResult, label: string): ComparableSummary {
  const s = baseline.summary
  return {
    label,
    stories: s.scenarios,
    scored: s.scored,
    judge_errors: s.judge_errors,
    mean_overall: s.mean_overall,
    min_overall: s.min_overall,
    disqualified: s.disqualified,
    criterion_means: s.criterion_means as Partial<Record<Criterion, number>>,
    first_draft: s.first_draft ?? null,
    after_streaming: s.after_streaming ?? null,
  }
}

/**
 * "The same rubric" checked, not assumed: the baseline was scored with a judge prompt whose
 * hash is in its file, and the trial's books must have been scored with that same text. A
 * list of what differs; empty means the two can be set side by side.
 */
export function rubricDifferences(rows: readonly FamilyEvalRow[], baseline: EvalResult): string[] {
  const out: string[] = []
  const judged = rows.filter((r) => r.judged_at !== null && r.judge_error === null)
  const shas = new Set(judged.map((r) => r.judge_prompt_sha))
  for (const sha of shas) {
    if (sha !== baseline.judge_prompt.sha256) {
      out.push(`judge prompt: ${judged.filter((r) => r.judge_prompt_sha === sha).length} book(s) scored with ${sha}, the baseline with ${baseline.judge_prompt.sha256}`)
    }
  }
  const models = new Set(judged.map((r) => r.judge_model))
  for (const model of models) {
    if (model !== baseline.judge_model) {
      out.push(`judge model: ${judged.filter((r) => r.judge_model === model).length} book(s) scored by ${model}, the baseline by ${baseline.judge_model}`)
    }
  }
  return out
}

const fmt = (v: number | null | undefined, dp = 2): string => (v === null || v === undefined ? '—' : v.toFixed(dp))
const share = (x: { passed: number; of: number } | null): string => (x && x.of > 0 ? `${x.passed}/${x.of} (${Math.round((x.passed / x.of) * 100)}%)` : '—')
const delta = (a: number | null | undefined, b: number | null | undefined): string =>
  a === null || a === undefined || b === null || b === undefined ? '' : `${a - b >= 0 ? '+' : ''}${(a - b).toFixed(2)}`

/** The report `pnpm eval:family` prints. Numbers and story ids only. */
export function formatFamilyReport(input: {
  rows: readonly FamilyEvalRow[]
  trial: ComparableSummary
  baseline: ComparableSummary
  differences: readonly string[]
}): string {
  const { rows, trial, baseline, differences } = input
  const lines: string[] = []
  const line = (name: string, a: string, b: string, d = ''): void => {
    lines.push(`  ${name.padEnd(28)}${a.padStart(14)}${b.padStart(16)}${d.padStart(9)}`)
  }
  lines.push(`Writer trial: ${trial.label}  vs  ${baseline.label}`)
  lines.push(`  Same judge, prompt and caps as pnpm eval (${JUDGE_PROMPT_FILE.replace(/\.md$/, '')}). Different stories: the family's own`)
  lines.push(`  requests against the ${baseline.stories} golden scenarios, so read the gap as a guide, not a paired result.`)
  if (differences.length > 0) {
    lines.push('')
    lines.push('  NOT THE SAME RUBRIC - do not compare these numbers:')
    for (const d of differences) lines.push(`    ${d}`)
  }
  lines.push('')
  line('', 'trial', 'baseline', 'gap')
  line('stories', String(trial.stories), String(baseline.stories))
  line('scored', String(trial.scored), String(baseline.scored))
  line('mean overall', fmt(trial.mean_overall), fmt(baseline.mean_overall), delta(trial.mean_overall, baseline.mean_overall))
  line('lowest overall', fmt(trial.min_overall), fmt(baseline.min_overall), delta(trial.min_overall, baseline.min_overall))
  line('disqualified', String(trial.disqualified), String(baseline.disqualified))
  line('judge could not score', String(trial.judge_errors), String(baseline.judge_errors))
  for (const c of CRITERIA) {
    line(`  ${c}`, fmt(trial.criterion_means[c]), fmt(baseline.criterion_means[c]), delta(trial.criterion_means[c], baseline.criterion_means[c]))
  }
  line('first drafts untouched', share(trial.first_draft), share(baseline.first_draft))
  const replaced = (s: ComparableSummary) => (s.after_streaming ? { passed: s.after_streaming.replaced, of: s.after_streaming.of } : null)
  const edited = (s: ComparableSummary) => (s.after_streaming ? { passed: s.after_streaming.edited, of: s.after_streaming.of } : null)
  line('edited after streaming', share(edited(trial)), share(edited(baseline)))
  line('replaced after streaming', share(replaced(trial)), share(replaced(baseline)))
  if (trial.scored > 0 && trial.scored < 8) {
    lines.push('')
    lines.push(`  ${trial.scored} scored book(s): too few for the mean to say much yet (one eval is 32).`)
  }
  lines.push('')
  lines.push('  book (story id)                       made        writer           overall  caps')
  for (const r of rows) {
    const overall = r.judge_error ? 'error' : r.overall_final === null ? 'unscored' : fmt(r.overall_final)
    const caps = r.judge_error ? r.judge_error.slice(0, 60) : (r.caps_applied ?? []).filter((c) => c !== 'none').join(', ') || (r.disqualified ? 'DISQUALIFIED' : '')
    lines.push(`  ${r.story_id}  ${r.created_at.slice(0, 10)}  ${r.writer_model.padEnd(15)}  ${overall.padStart(7)}  ${r.disqualified ? 'DQ ' : ''}${caps}`)
  }
  return lines.join('\n')
}
