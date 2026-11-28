import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BlindnessViolationError } from '@/lib/eval/blind'
import {
  bibleForJudge,
  clearJudgeErrors,
  permanentFailure,
  formatFamilyReport,
  loadFamilyBook,
  loadFamilyEvalRows,
  rubricDifferences,
  runFamilyEval,
  summarizeBaseline,
  summarizeFamilyRows,
  type FamilyEvalRow,
  type ScoreFn,
} from '@/lib/eval/family'
import type { EvalResult } from '@/lib/eval/harness'
import { loadJudgePrompt, type ScoreStoryResult } from '@/lib/eval/judge'
import { getOrCreateSeries } from '@/lib/bible'
import { applyCaps, targetWords, type StoryBible } from '@/lib/schemas'
import { stubStory } from '../helpers/fixtures'
import { createTestFamily, databaseAvailable, deleteFactPack, insertFactPack, type TestFamily } from '../helpers/pipeline-db'
import { goodFactPack } from '../helpers/story'

/**
 * Issue #132, VT-WT5: `pnpm eval:family` against the local database. The judge is a stand-in
 * (no model call): what is tested is which books are scored, what the judge is given, what is
 * saved, and the report beside the Sonnet eval.
 */
const available = await databaseAvailable()

const BASELINE = JSON.parse(readFileSync(join(process.cwd(), 'eval/results/eval-2026-11-04.json'), 'utf8')) as EvalResult
const TOPIC_KEY = `family-eval-${randomUUID().slice(0, 8)}`
const NOW = new Date('2026-11-29T09:00:00.000Z')

const BIBLE_BEFORE: StoryBible = {
  children: [{ name: 'Milo', age: 7, likes: ['LEGO'], role_notes: null }],
  recurring: [{ name: 'Click', type: 'character', rule: 'a minifigure who knows the way' }],
  catchphrases: [],
  topics_covered: [],
  last_story: null,
  tone_history: [],
  avoid: [],
}

function judged(scores: Record<string, number>, opts: { disqualified?: boolean; caps?: string[] } = {}): ScoreStoryResult {
  const evidence = { center: 'e', craft: 'e', facts: 'e', age_fit: 'e', continuity: 'e', delight: 'e' }
  const raw = {
    scores: scores as never,
    evidence,
    caps_applied: opts.caps ?? ['none'],
    disqualified: opts.disqualified ?? false,
    overall: 4.9,
    editor_notes: [],
    best_moment: 'a line from the story',
    worst_moment: 'another line',
  }
  const final = applyCaps(raw, { guardrailBreach: opts.disqualified ?? false, inventedFact: false, wordCountOutOfRange: false })
  return {
    ok: true,
    raw,
    final,
    best_moment: raw.best_moment,
    worst_moment: raw.worst_moment,
    capContext: { guardrailBreach: false, inventedFact: false, wordCountOutOfRange: false, narrativeWordCount: 1400, target: { min: 1300, max: 1700 }, factSourcing: 'checked', notes: [] },
    model: BASELINE.judge_model,
    attempts: 1,
    costUsd: 0.11,
    latencyMs: 10,
    replayed: false,
  }
}

describe.skipIf(!available)('VT-WT5: eval:family (int)', () => {
  let family: TestFamily
  let seriesId: string
  let factPackId: string
  const stories: string[] = []

  async function saveBook(opts: { firstDraft: boolean; after: FamilyEvalRow['after_streaming']; bible?: StoryBible | null }): Promise<string> {
    const id = randomUUID()
    const { error } = await family.db.from('stories').insert({
      id,
      family_id: family.familyId,
      series_id: seriesId,
      topic_input: 'how LEGO bricks are made',
      topic_key: TOPIC_KEY,
      fact_pack_id: factPackId,
      tones: ['funny'],
      length_minutes: 10,
      age_band: 'A',
      title: 'A test book',
      content: stubStory(),
      word_count: 1400,
      quality: {},
      status: 'ready',
    })
    if (error) throw new Error(error.message)
    const { error: evalError } = await family.db.from('story_evals').insert({
      story_id: id,
      family_id: family.familyId,
      writer_model: 'glm-5.3-flash',
      master_prompt: 'master.glm.v1',
      bible_before: opts.bible === undefined ? BIBLE_BEFORE : opts.bible,
      write_calls: opts.firstDraft ? 1 : 2,
      after_streaming: opts.after,
      first_draft_untouched: opts.firstDraft,
      created_at: new Date(Date.UTC(2026, 10, 28, 20, stories.length)).toISOString(),
    })
    if (evalError) throw new Error(evalError.message)
    stories.push(id)
    return id
  }

  beforeAll(async () => {
    family = await createTestFamily({ label: 'family-eval' })
    seriesId = (await getOrCreateSeries(family.familyId, family.children.map((c) => c.id), family.db)).id
    factPackId = await insertFactPack(family.db, TOPIC_KEY, goodFactPack(), 'How LEGO bricks are made')
  })
  afterAll(async () => {
    await family?.cleanup()
    await deleteFactPack(family.db, TOPIC_KEY)
  })

  it('gives the judge what pnpm eval gives it: the children, the request, the bible before, the gate and the pack', async () => {
    const id = await saveBook({ firstDraft: true, after: 'unchanged' })
    const row = (await loadFamilyEvalRows(family.db, { familyId: family.familyId })).find((r) => r.story_id === id)!
    const book = await loadFamilyBook(family.db, row)
    expect(book.context).toMatchObject({
      age_band: 'A',
      tones: ['funny'],
      length_minutes: 10,
      target_words: targetWords({ band: 'A', minutes: 10 }),
      topic_label: 'how LEGO bricks are made',
      bible: BIBLE_BEFORE,
      fact_pack: null,
    })
    expect(book.context.children.map((c) => c.name).sort()).toEqual(['Juno', 'Milo'])
    expect(book.context.children.find((c) => c.name === 'Milo')).toMatchObject({ age: 7, likes: ['LEGO', 'sharks'] })
    expect(book.story.title).toBe(stubStory().title)
    expect(book.factPack?.facts.length).toBeGreaterThan(0)
  })

  it('a first story is scored with no bible, as the eval\'s first-story scenarios are', () => {
    expect(bibleForJudge(null)).toBeNull()
    expect(bibleForJudge({ ...BIBLE_BEFORE, recurring: [] })).toBeNull()
    expect(bibleForJudge(BIBLE_BEFORE)).toBe(BIBLE_BEFORE)
  })

  it('scores only the books with no score, saves the capped score, and carries on past a failure', async () => {
    const second = await saveBook({ firstDraft: false, after: 'edited' })
    const broken = await saveBook({ firstDraft: false, after: 'replaced' })
    const [first] = stories
    const seen: string[] = []
    const score: ScoreFn = async (input) => {
      seen.push(input.story.title)
      // Not tagged with the story: the judge's cost is not part of what the story cost to make.
      expect(input.storyId).toBeNull()
      expect(input.familyId).toBeNull()
      expect(input.factPack).not.toBeNull()
      const n = seen.length
      if (n === 1) return judged({ center: 5, craft: 4, facts: 4, age_fit: 4, continuity: 5, delight: 4 })
      if (n === 2) return judged({ center: 5, craft: 5, facts: 5, age_fit: 5, continuity: 5, delight: 5 }, { disqualified: true, caps: ['guardrail: rule 4'] })
      return { ok: false, error: 'judge_error', reason: 'response contained no parseable JSON object', model: BASELINE.judge_model, attempts: 2, costUsd: 0.2, latencyMs: 5 }
    }

    const run = await runFamilyEval({ db: family.db, familyId: family.familyId, score, now: () => NOW })
    expect(run).toMatchObject({ scored: 2, errors: 1, failed: 0 })
    expect(run.costUsd).toBeCloseTo(0.42, 5)

    const rows = await loadFamilyEvalRows(family.db, { familyId: family.familyId })
    const byId = new Map(rows.map((r) => [r.story_id, r]))
    const prompt = loadJudgePrompt()
    expect(byId.get(first!)).toMatchObject({
      judged_at: expect.stringContaining('2026-11-29'),
      judge_model: BASELINE.judge_model,
      judge_prompt_sha: prompt.sha256,
      judge_error: null,
      scores: { center: 5, craft: 4, facts: 4, age_fit: 4, continuity: 5, delight: 4 },
      // Recomputed by our code from the criterion scores, not the 4.9 the judge said.
      overall_raw: 4.9,
      overall_final: 4.3,
      disqualified: false,
      judge_cost_usd: 0.11,
    })
    // The cap is ours: a guardrail breach is overall 1, whatever the criteria say.
    expect(byId.get(second)).toMatchObject({ disqualified: true, overall_final: 1 })
    expect(byId.get(broken)).toMatchObject({ judge_error: 'response contained no parseable JSON object', overall_final: null, scores: null })

    // A second run finds nothing to do: a scored book, and one the judge failed on, are not paid for twice.
    let called = 0
    const again = await runFamilyEval({ db: family.db, familyId: family.familyId, score: async () => { called += 1; return judged({ center: 1, craft: 1, facts: 1, age_fit: 1, continuity: 1, delight: 1 }) } })
    expect(called).toBe(0)
    expect(again).toEqual({ scored: 0, errors: 0, failed: 0, costUsd: 0 })
  })

  it('a book whose story is gone gets the reason on its row, and the run does not stop', async () => {
    const gone = await saveBook({ firstDraft: true, after: 'unchanged' })
    // The children it was written for have left the family: nothing to tell the judge.
    await family.db.from('series').update({ child_ids: [randomUUID()] }).eq('id', seriesId)
    const run = await runFamilyEval({ db: family.db, familyId: family.familyId, score: async () => judged({ center: 5, craft: 5, facts: 5, age_fit: 5, continuity: 5, delight: 5 }), now: () => NOW })
    await family.db.from('series').update({ child_ids: family.children.map((c) => c.id) }).eq('id', seriesId)
    expect(run).toMatchObject({ scored: 0, errors: 1 })
    const row = (await loadFamilyEvalRows(family.db, { familyId: family.familyId })).find((r) => r.story_id === gone)!
    expect(row.judge_error).toMatch(/^not scored: the children/)
    expect(row.judged_at).not.toBeNull()
  })

  it('the report sets the trial beside the Sonnet eval, with numbers and story ids only', async () => {
    const rows = await loadFamilyEvalRows(family.db, { familyId: family.familyId })
    const trial = summarizeFamilyRows(rows, 'glm-5.3-flash + master.glm.v1')
    expect(trial).toMatchObject({
      stories: 4,
      scored: 2,
      judge_errors: 2,
      min_overall: 1,
      disqualified: 1,
      first_draft: { passed: 2, of: 4 },
      after_streaming: { unchanged: 2, edited: 1, replaced: 1, of: 4 },
    })
    expect(trial.mean_overall).toBeCloseTo((4.3 + 1) / 2, 5)
    expect(trial.criterion_means.craft).toBeCloseTo(4.5, 5)

    const baseline = summarizeBaseline(BASELINE, 'eval-2026-11-04')
    expect(baseline).toMatchObject({ stories: 32, scored: 32, mean_overall: 4.12, min_overall: 3.7, disqualified: 0, first_draft: { passed: 15, of: 32 } })
    expect(baseline.after_streaming).toMatchObject({ replaced: 2, of: 32 })

    expect(rubricDifferences(rows, BASELINE)).toEqual([])
    const report = formatFamilyReport({ rows, trial, baseline, differences: [] })
    expect(report).toContain('mean overall')
    expect(report).toMatch(/mean overall\s+2\.65\s+4\.12\s+-1\.47/)
    expect(report).toMatch(/first drafts untouched\s+2\/4 \(50%\)\s+15\/32 \(47%\)/)
    expect(report).toMatch(/replaced after streaming\s+1\/4 \(25%\)\s+2\/32 \(6%\)/)
    expect(report).toContain('too few for the mean to say much')
    for (const id of stories) expect(report).toContain(id)
    // Nothing from the story or about the children.
    for (const word of ['Milo', 'Juno', 'A test book', 'a line from the story']) expect(report).not.toContain(word)
  })

  it('a different judge prompt or judge model is called out, not compared', async () => {
    const rows = await loadFamilyEvalRows(family.db, { familyId: family.familyId })
    const other: EvalResult = { ...BASELINE, judge_prompt: { version: 'judge.v2', sha256: 'aaaaaaaaaaaaaaaa' }, judge_model: 'some-other-judge' }
    const differences = rubricDifferences(rows, other)
    expect(differences).toHaveLength(2)
    expect(differences[0]).toContain('judge prompt')
    expect(differences[1]).toContain('judge model')
    const report = formatFamilyReport({ rows, trial: summarizeFamilyRows(rows, 't'), baseline: summarizeBaseline(other, 'b'), differences })
    expect(report).toContain('NOT THE SAME RUBRIC')
  })

  it('the judge prompt on disk is the one the Sonnet baseline was scored with', () => {
    expect(loadJudgePrompt().sha256).toBe(BASELINE.judge_prompt.sha256)
  })

  it('a failure that may pass leaves the book unscored for the next run; a word the blind check trips on is kept without the story\'s text', async () => {
    const id = await saveBook({ firstDraft: true, after: 'unchanged' })
    const row = async () => (await loadFamilyEvalRows(family.db, { familyId: family.familyId })).find((r) => r.story_id === id)!

    // The gateway is down: nothing is written, and the book is still waiting.
    const down = await runFamilyEval({ db: family.db, familyId: family.familyId, score: async () => { throw new Error('529 overloaded') }, now: () => NOW })
    expect(down).toMatchObject({ scored: 0, errors: 0, failed: 1 })
    expect(await row()).toMatchObject({ judged_at: null, judge_error: null })

    // The blind check quotes the payload around the match. Only the matched word is saved.
    const leak = new BlindnessViolationError('SCORE payload', [{ needle: 'fable', kind: 'brand_word', index: 10, excerpt: '…Milo opened the book of fables and…' }])
    const blind = await runFamilyEval({ db: family.db, familyId: family.familyId, score: async () => { throw leak }, now: () => NOW })
    expect(blind).toMatchObject({ scored: 0, errors: 1, failed: 0 })
    const saved = await row()
    expect(saved.judge_error).toBe('blind_check: the story or the request contains fable')
    expect(saved.judge_error).not.toContain('Milo')
    expect(permanentFailure(leak)).not.toContain('opened the book')
    expect(permanentFailure(new Error('socket hang up'))).toBeNull()

    // --retry-errors makes it unscored again, and this time it scores.
    expect(await clearJudgeErrors(family.db, family.familyId)).toBeGreaterThanOrEqual(1)
    const retried = await runFamilyEval({ db: family.db, familyId: family.familyId, score: async () => judged({ center: 4, craft: 4, facts: 4, age_fit: 4, continuity: 4, delight: 4 }), now: () => NOW })
    expect(retried.scored).toBeGreaterThanOrEqual(1)
    expect((await row()).overall_final).toBe(4)
  })
})
