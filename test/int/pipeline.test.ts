import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  prepareGeneration,
  runGeneration,
  SseChannel,
  type GenerationDeps,
  type PreparedGeneration,
  type QuotaState,
  type QuotaService,
} from '@/lib/generate'
import { MemoryLogSink } from '@/lib/ai'
import { getOrCreateSeries, loadBible, reloadBible, writeBible } from '@/lib/bible'
import {
  DAILY_STORY_LIMIT,
  storyWordCount,
  targetWords,
  wordCountWithinTolerance,
  type OutputSafetyReview,
  type SseEvent,
  type StoryBible,
  type StoryOutput,
} from '@/lib/schemas'
import { createTestFamily, databaseAvailable, insertFactPack, type TestFamily } from '../helpers/pipeline-db'
import { FIXTURE_FACT_PACK, FIXTURE_TOPIC_KEY, FIXTURE_TOPIC_LABEL } from '../helpers/factpack'
import {
  callFixtureKey,
  streamFixtureKey,
  stubBible,
  stubFixture,
  stubRewrittenStory,
  stubStory,
  STUB_PASSING_REVIEW,
} from '../helpers/fixtures'
import { buildPrompt } from '@/lib/generate/prompt'
import { buildQualityReviewMessage } from '@/lib/quality/review'
import { buildBibleUpdateMessage } from '@/lib/bible'
import { loadPrompt } from '@/lib/prompts'
import { modelForRole } from '@/lib/ai'

/**
 * F6 + F7 integration: the streamed half of the pipeline, end to end.
 *
 * **What the model responses are.** There is no API key in this environment, so the writer
 * and reviewer responses here are SYNTHETIC payloads written by `test/helpers/fixtures.ts`
 * into the temp `FIXTURE_DIR`, never into `test/fixtures/model/`. They prove our plumbing -
 * the streaming JSON scan, SSE ordering, the gate's decisions, the save, the quota call
 * sites, the background bible update. They prove nothing about the real writing model's
 * output: the tests that need real model judgement are in `test/blocked/`.
 *
 * `PreparedGeneration` is built directly rather than through `prepareGeneration`, because the
 * writer's prompt must be byte-identical across runs (hence a fixed fact pack under a lane-2
 * key, not a researched pack under `history-of-lego` in the globally shared table).
 * `prepareGeneration` has its own tests below - the same split the HTTP contract makes.
 */

const available = await databaseAvailable()
/**
 * Recording cannot record "there is no fixture". Three tests here assert the failure path
 * that a MISSING fixture produces, so they are skipped while recording rather than writing a
 * fixture that would make them pass for the wrong reason on the next replay.
 */
const RECORDING = process.env.RECORD_FIXTURES === '1' || process.env.RECORD_FIXTURES === 'true'
/** Pinned so the bible-update prompt (and therefore its fixture) does not change at midnight. */
const FIXED_NOW = new Date('2026-09-27T20:00:00.000Z')

/**
 * The bible every test starts from, written explicitly rather than taken from
 * `emptyBible()`. A fresh series orders `children` by child UUID, which is random per run -
 * and the bible is part of the writer's prompt, so that randomness would change the prompt
 * bytes and the fixture key on every run.
 */
const BIBLE_AT_START: StoryBible = {
  children: [
    { name: 'Cruz', age: 7, likes: ['LEGO', 'sharks'], role_notes: null },
    { name: 'Phoenix', age: 4, likes: ['dinosaurs'], role_notes: null },
  ],
  recurring: [],
  catchphrases: [],
  topics_covered: [],
  last_story: null,
  tone_history: [],
  avoid: [],
}

/** Records what the pipeline asked the quota service, in order. */
class RecordingQuota implements QuotaService {
  readonly calls: string[] = []
  async preflight(): Promise<QuotaState> {
    this.calls.push('preflight')
    return this.state(0, true)
  }
  async consumeQuota(): Promise<QuotaState> {
    this.calls.push('consumeQuota')
    return this.state(1, true)
  }
  private state(used: number, allowed: boolean): QuotaState {
    return {
      used,
      limit: DAILY_STORY_LIMIT,
      resets_at: '2026-09-28T00:00:00.000Z',
      allowed,
      generation_enabled: true,
    }
  }
}

async function collect(
  prepared: PreparedGeneration,
  deps: GenerationDeps,
): Promise<{ events: SseEvent[]; result: Awaited<ReturnType<typeof runGeneration>> }> {
  const channel = new SseChannel()
  const events: SseEvent[] = []
  const drain = (async () => {
    try {
      for await (const event of channel.events()) events.push(event)
    } catch {
      /* a pre-stream failure is asserted on the channel, not here */
    }
  })()
  const result = await runGeneration(prepared, channel, deps)
  await drain
  return { events, result }
}

describe.skipIf(!available)('F6 pipeline, streamed half (int, fixtures)', () => {
  let family: TestFamily
  let db: SupabaseClient
  let seriesId: string
  let factPackId: string

  /**
   * A FRESH family (and therefore a fresh, empty bible) per test. The bible is part of the
   * writer's prompt, so a test that inherited the previous test's bible would have a
   * different prompt and need its own recorded fixture - and the order of the file would
   * become load-bearing. An empty bible makes every test's write prompt identical.
   */
  beforeAll(async () => {
    db = (await createTestFamily({ label: 'f6-pack' })).db
    factPackId = await insertFactPack(db, FIXTURE_TOPIC_KEY, FIXTURE_FACT_PACK, FIXTURE_TOPIC_LABEL)
  })
  beforeEach(async () => {
    family = await createTestFamily({ label: 'f6' })
    const series = await getOrCreateSeries(
      family.familyId,
      family.children.map((c) => c.id),
      family.db,
    )
    seriesId = series.id
    // Pin the starting bible so the writer's prompt is byte-identical on every run.
    await writeBible(await loadBible(seriesId, { db: family.db }), BIBLE_AT_START, family.db)
  })
  afterEach(async () => {
    await family?.cleanup()
  })
  afterAll(async () => {
    await db.from('fact_packs').delete().eq('topic_key', FIXTURE_TOPIC_KEY)
  })

  /**
   * A fresh PreparedGeneration. `topicLabel` is the only thing tests vary, because it is the
   * only part of the prompt that lets a test deliberately miss the recorded fixture.
   */
  async function prepared(topicLabel = FIXTURE_TOPIC_LABEL): Promise<PreparedGeneration> {
    const bible = await loadBible(seriesId, { db: family.db })
    const target = targetWords({ band: 'A', minutes: 10 })
    return {
      familyId: family.familyId,
      storyId: randomUUID(),
      seriesId,
      children: family.children.map((c) => ({
        id: c.id,
        first_name: c.first_name,
        age: c.age,
        likes: c.first_name === 'Cruz' ? ['LEGO', 'sharks'] : ['dinosaurs'],
        notes: null,
        reading_level: null,
      })),
      band: 'A',
      request: {
        children: [
          { name: 'Cruz', age: 7, likes: ['LEGO', 'sharks'], notes: null },
          { name: 'Phoenix', age: 4, likes: ['dinosaurs'], notes: null },
        ],
        age_band: 'A',
        tones: ['funny', 'exciting'],
        length_minutes: 10,
        target_words: target,
        topic_label: topicLabel,
        topic_key: FIXTURE_TOPIC_KEY,
        avoid: [],
        care_notes: null,
        rewrite_reasons: [],
      },
      factPack: {
        id: factPackId,
        topic_key: FIXTURE_TOPIC_KEY,
        topic_label: FIXTURE_TOPIC_LABEL,
        content: FIXTURE_FACT_PACK,
        sources: FIXTURE_FACT_PACK.sources,
        model: 'fixture',
        version: 1,
        use_count: 1,
        quality_score: 4.6,
        status: 'ready',
      },
      topicInput: FIXTURE_TOPIC_LABEL,
      topicKey: FIXTURE_TOPIC_KEY,
      topicLabel,
      quota: {
        used: 0,
        limit: DAILY_STORY_LIMIT,
        resets_at: '2026-09-28T00:00:00.000Z',
        allowed: true,
        generation_enabled: true,
      },
      bibleVersion: bible.version,
    }
  }

  /**
   * Write the synthetic model responses this run will need.
   *
   * Every key is derived from the SAME prompt builders the pipeline uses, so if a prompt
   * changes the key changes and these stubs stop matching - which is the intended failure, not
   * a silently stale response.
   */
  function stubResponsesFor(
    run: PreparedGeneration,
    opts: { rewriteReasons?: string[] } = {},
  ): { story: StoryOutput; rewritten: StoryOutput } {
    const writer = modelForRole('writer')
    const helperModel = modelForRole('helper')
    const story = stubStory()
    const rewritten = stubRewrittenStory()

    // 1. the streamed write
    const writePrompt = buildPrompt({
      request: run.request,
      bible: BIBLE_AT_START,
      factPack: FIXTURE_FACT_PACK,
    })
    stubFixture(
      'write',
      streamFixtureKey({
        model: writer,
        system: writePrompt.system,
        messages: writePrompt.messages,
        maxTokens: 16_000,
        thinking: 'adaptive',
      }),
      JSON.stringify(story),
      { input_tokens: 1_400, cache_write_tokens: 4_200, output_tokens: 5_200 },
    )

    // 2. the quality review of that story
    stubFixture(
      'quality',
      callFixtureKey({
        model: helperModel,
        system: [{ text: loadPrompt('quality-review').body }],
        messages: [
          {
            role: 'user',
            content: buildQualityReviewMessage(story, run.request, FIXTURE_FACT_PACK),
          },
        ],
        maxTokens: 2_000,
      }),
      JSON.stringify(STUB_PASSING_REVIEW),
      { input_tokens: 7_800, output_tokens: 120 },
    )

    // 3. the rewrite, and the review of the rewrite
    if (opts.rewriteReasons && opts.rewriteReasons.length > 0) {
      const rewriteRequest = { ...run.request, rewrite_reasons: opts.rewriteReasons }
      const rewritePrompt = buildPrompt({
        request: rewriteRequest,
        bible: BIBLE_AT_START,
        factPack: FIXTURE_FACT_PACK,
      })
      stubFixture(
        'rewrite',
        callFixtureKey({
          model: writer,
          system: rewritePrompt.system,
          messages: rewritePrompt.messages,
          maxTokens: 16_000,
          thinking: 'adaptive',
        }),
        JSON.stringify(rewritten),
        { input_tokens: 1_500, cache_read_tokens: 4_200, output_tokens: 5_300 },
      )
      stubFixture(
        'quality',
        callFixtureKey({
          model: helperModel,
          system: [{ text: loadPrompt('quality-review').body }],
          messages: [
            {
              role: 'user',
              content: buildQualityReviewMessage(rewritten, rewriteRequest, FIXTURE_FACT_PACK),
            },
          ],
          maxTokens: 2_000,
        }),
        JSON.stringify(STUB_PASSING_REVIEW),
        { input_tokens: 7_900, output_tokens: 120 },
      )
    }

    // 4. the background bible update, for whichever story ends up saved
    for (const saved of [story, rewritten]) {
      stubFixture(
        'bible_update',
        callFixtureKey({
          model: helperModel,
          system: [{ text: loadPrompt('bible-update').body }],
          messages: [
            {
              role: 'user',
              content: buildBibleUpdateMessage(BIBLE_AT_START, saved, {
                topic: run.topicLabel,
                storyId: run.storyId,
                date: '2026-09-27',
                tones: run.request.tones,
              }),
            },
          ],
          maxTokens: 4_000,
        }),
        JSON.stringify(stubBible(BIBLE_AT_START.children)),
        { input_tokens: 4_600, output_tokens: 640 },
      )
    }

    return { story, rewritten }
  }

  it('F6 VT: the happy path saves a ready story with quality populated, one write call', async () => {
    const run = await prepared()
    stubResponsesFor(run)
    const sink = new MemoryLogSink()
    const quota = new RecordingQuota()

    const { events, result } = await collect(run, { db: family.db, sink, quota, now: () => FIXED_NOW })

    expect(result.status).toBe('ready')
    expect(result.writeCalls).toBe(1)

    // Exactly one writing-model call, plus the cheap steps around it.
    const purposes = sink.rows.map((r) => r.purpose)
    expect(purposes.filter((p) => p === 'write')).toHaveLength(1)
    expect(purposes.filter((p) => p === 'rewrite')).toHaveLength(0)
    expect(purposes).toContain('quality')

    const { data: row } = await family.db
      .from('stories')
      .select('status, word_count, quality, title, age_band, fact_pack_id, topic_key')
      .eq('id', run.storyId)
      .single()
    const stored = row as {
      status: string
      word_count: number
      quality: { outcome: string; deterministic_passed: boolean; review: unknown }
      age_band: string
      fact_pack_id: string | null
      topic_key: string
    }
    expect(stored.status).toBe('ready')
    expect(stored.word_count).toBeGreaterThan(0)
    expect(stored.quality.outcome).toBe('pass')
    expect(stored.quality.deterministic_passed).toBe(true)
    expect(stored.quality.review).not.toBeNull()
    expect(stored.age_band).toBe('A')
    expect(stored.fact_pack_id).toBe(factPackId)
    expect(stored.topic_key).toBe(FIXTURE_TOPIC_KEY)

    // F8 AC: quota touched exactly once, and only after the insert.
    expect(quota.calls).toEqual(['consumeQuota'])

    // SSE contract: meta first, then chapters, `done` last.
    expect(events[0]?.type).toBe('meta')
    const done = events.at(-1)
    expect(done?.type).toBe('done')
    if (done?.type !== 'done') throw new Error('expected a done event')
    expect(done.story_id).toBe(run.storyId)
    expect(done.quality.outcome).toBe('pass')
    expect(done.word_count).toBe(stored.word_count)
    expect(done.quota).toEqual({ used: 1, limit: DAILY_STORY_LIMIT })

    // Progressive rendering: prose arrives well before the stream ends.
    const firstDelta = events.findIndex((e) => e.type === 'chapter_delta')
    const doneAt = events.findIndex((e) => e.type === 'done')
    expect(firstDelta).toBeGreaterThan(0)
    expect(firstDelta).toBeLessThan(doneAt)

    // The streamed deltas reassemble into exactly the saved story.
    const story = done.story as StoryOutput
    for (const [index, chapter] of story.chapters.entries()) {
      const streamed = events
        .filter((e): e is Extract<SseEvent, { type: 'chapter_delta' }> =>
          e.type === 'chapter_delta' && e.index === index,
        )
        .map((e) => e.text)
        .join('')
      expect(streamed, `chapter ${index}`).toBe(chapter.text)
    }

    // F6 AC: word count inside the band's range with the +/-15% tolerance.
    const words = storyWordCount(story)
    expect(
      wordCountWithinTolerance(words, run.request.target_words),
      `${words} narrative words, target ${run.request.target_words.min}-${run.request.target_words.max}`,
    ).toBe(true)

    // The bible update ran in the background and stayed inside its budget.
    if (result.bibleUpdate) await result.bibleUpdate
    const bible = await reloadBible(seriesId, family.db)
    expect(bible.version).toBeGreaterThan(1)
    expect(bible.content.last_story?.title).toBe(story.title)
    expect(bible.token_estimate).toBeLessThanOrEqual(800)
    expect(bible.content.topics_covered.map((t) => t.topic)).toContain(FIXTURE_TOPIC_LABEL)
  })

  it('F7 VT: a hard safety violation triggers exactly one rewrite carrying the reasons', async () => {
    const run = await prepared()
    // The reasons the gate will produce from the stubbed safety verdict below. They go into
    // the rewrite prompt, so the stub has to be keyed on exactly these.
    stubResponsesFor(run, {
      rewriteReasons: [
        'GUARDRAILS rule 3 breached',
        'output safety review returned safe: false',
        'scary_level 3 above band A limit',
      ],
    })
    const sink = new MemoryLogSink()
    let reviewCall = 0
    // Lane 6's L4 reviewer, stubbed to fail the first attempt only.
    const safetyReviewer = {
      review: async (): Promise<OutputSafetyReview> => {
        reviewCall += 1
        return reviewCall === 1
          ? {
              safe: false,
              violations: [
                {
                  rule: 3,
                  quote: 'a monster chased them down the corridor',
                  severity: 'hard' as const,
                },
              ],
              scary_level: 3,
              positive_portrayal: true,
              ending_safe: true,
            }
          : {
              safe: true,
              violations: [],
              scary_level: 0,
              positive_portrayal: true,
              ending_safe: true,
            }
      },
    }

    const { events, result } = await collect(run, {
      db: family.db,
      sink,
      quota: new RecordingQuota(),
      safetyReviewer,
      now: () => FIXED_NOW,
    })

    // F6 AC: at most two writing-model calls, and exactly two here.
    expect(result.writeCalls).toBe(2)
    const purposes = sink.rows.map((r) => r.purpose)
    expect(purposes.filter((p) => p === 'write')).toHaveLength(1)
    expect(purposes.filter((p) => p === 'rewrite')).toHaveLength(1)

    expect(reviewCall).toBe(2)
    expect(result.quality?.attempt).toBe(2)
    expect(result.status).toBe('ready')
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })

  it('F7 VT: two consecutive failures flag the story - still saved, still shown', async () => {
    const run = await prepared()
    stubResponsesFor(run, { rewriteReasons: ['scary_level 2 above band A limit'] })
    const alwaysTooScary = {
      // Above band A's scary limit of 0 both times, but no HARD rule breach:
      // flagged with a soft banner, never a blank screen.
      review: async (): Promise<OutputSafetyReview> => ({
        safe: true,
        violations: [],
        scary_level: 2,
        positive_portrayal: true,
        ending_safe: true,
      }),
    }

    const { events, result } = await collect(run, {
      db: family.db,
      sink: new MemoryLogSink(),
      quota: new RecordingQuota(),
      safetyReviewer: alwaysTooScary,
      now: () => FIXED_NOW,
    })

    expect(result.status).toBe('flagged')
    expect(result.quality?.outcome).toBe('flagged')
    expect(result.writeCalls).toBe(2)
    expect(result.quality?.rewrite_reasons.join(' ')).toMatch(/scary_level 2 above band A limit/)

    const done = events.at(-1)
    expect(done?.type).toBe('done')
    if (done?.type === 'done') expect(done.quality.outcome).toBe('flagged')

    const { data: row } = await family.db
      .from('stories')
      .select('status, content')
      .eq('id', run.storyId)
      .single()
    expect((row as { status: string }).status).toBe('flagged')
    expect((row as { content: StoryOutput }).content.chapters.length).toBeGreaterThanOrEqual(6)
  })

  it('a second hard violation discards the story: no row, no quota, a kind message', async () => {
    const run = await prepared()
    stubResponsesFor(run, {
      rewriteReasons: [
        'GUARDRAILS rule 3 breached',
        'output safety review returned safe: false',
        'scary_level 3 above band A limit',
      ],
    })
    const quota = new RecordingQuota()
    const alwaysHard = {
      review: async (): Promise<OutputSafetyReview> => ({
        safe: false,
        violations: [{ rule: 3, quote: 'it was right behind him', severity: 'hard' as const }],
        scary_level: 3,
        positive_portrayal: true,
        ending_safe: true,
      }),
    }

    const { events, result } = await collect(run, {
      db: family.db,
      sink: new MemoryLogSink(),
      quota,
      safetyReviewer: alwaysHard,
      now: () => FIXED_NOW,
    })

    expect(result.status).toBe('discarded')
    const error = events.at(-1)
    expect(error?.type).toBe('error')
    if (error?.type === 'error') {
      expect(error.code).toBe('generation_failed')
      expect(error.quota_consumed).toBe(false)
      expect(error.message).toMatch(/didn't use one of your stories/)
    }
    expect(quota.calls).not.toContain('consumeQuota')

    const { data: row } = await family.db.from('stories').select('id').eq('id', run.storyId).maybeSingle()
    expect(row).toBeNull()
  })

  it.skipIf(RECORDING)('F6 VT: a failed write is a pre-stream 502 - no story row, no quota consumed', async () => {
    // No recorded fixture for this prompt, so the write fails before a byte is emitted -
    // which is exactly what lets the route answer with a real HTTP status.
    const run = await prepared('a topic with no recorded write fixture at all')
    const quota = new RecordingQuota()
    const channel = new SseChannel()
    const rejections: unknown[] = []
    channel.waitForOpen().catch((err) => rejections.push(err))

    const result = await runGeneration(run, channel, {
      db: family.db,
      sink: new MemoryLogSink(),
      quota,
      now: () => FIXED_NOW,
    })

    expect(result.status).toBe('failed')
    expect(channel.isOpen).toBe(false)
    await Promise.resolve()
    expect(rejections).toHaveLength(1)
    expect((rejections[0] as { status: number }).status).toBe(502)
    expect((rejections[0] as { error: { code: string } }).error.code).toBe('generation_failed')

    expect(quota.calls).not.toContain('consumeQuota')
    const { data: row } = await family.db.from('stories').select('id').eq('id', run.storyId).maybeSingle()
    expect(row).toBeNull()
    const { data: usage } = await family.db
      .from('daily_usage')
      .select('count')
      .eq('family_id', family.familyId)
      .maybeSingle()
    expect(usage).toBeNull()
  })
})

describe.skipIf(!available)('F6 prepareGeneration failure paths (int, no model calls)', () => {
  let family: TestFamily

  beforeAll(async () => {
    family = await createTestFamily({ label: 'f6-prep' })
  })
  afterAll(async () => {
    await family?.cleanup()
  })

  const base = () => ({
    child_ids: family.children.map((c) => c.id),
    topic_input: 'the history of LEGO',
    tones: ['funny'],
    length_minutes: 10,
  })

  it('rejects a malformed body with 400 before any model call', async () => {
    const sink = new MemoryLogSink()
    const result = await prepareGeneration(
      family.familyId,
      { ...base(), length_minutes: 7 },
      { db: family.db, sink },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.error.code).toBe('invalid_request')
      expect(result.error.quota_consumed).toBe(false)
    }
    expect(sink.rows).toHaveLength(0)
  })

  it('rejects a child id from another family with 400, not a partial story', async () => {
    const other = await createTestFamily({ label: 'f6-other' })
    try {
      const result = await prepareGeneration(
        family.familyId,
        { ...base(), child_ids: [other.children[0]!.id] },
        { db: family.db, sink: new MemoryLogSink() },
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(400)
    } finally {
      await other.cleanup()
    }
  })

  it('returns 429 with the reset time when the quota is spent, before any model call', async () => {
    const sink = new MemoryLogSink()
    const spent: QuotaService = {
      preflight: async () => ({
        used: 3,
        limit: 3,
        resets_at: '2026-09-28T00:00:00.000Z',
        allowed: false,
        generation_enabled: true,
      }),
      consumeQuota: async () => {
        throw new Error('consumeQuota must not be called on a refused request')
      },
    }
    const result = await prepareGeneration(family.familyId, base(), {
      db: family.db,
      sink,
      quota: spent,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(429)
      expect(result.error.code).toBe('quota_exceeded')
      expect(result.error.resets_at).toBe('2026-09-28T00:00:00.000Z')
    }
    expect(sink.rows).toHaveLength(0)
  })

  it('returns 503 when the daily budget cap is spent', async () => {
    const overBudget: QuotaService = {
      preflight: async () => ({
        used: 0,
        limit: 3,
        resets_at: '2026-09-28T00:00:00.000Z',
        allowed: true,
        generation_enabled: false,
        disabled_reason: 'budget_exceeded',
      }),
      consumeQuota: async () => {
        throw new Error('consumeQuota must not be called')
      },
    }
    const result = await prepareGeneration(family.familyId, base(), {
      db: family.db,
      quota: overBudget,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(503)
      expect(result.error.code).toBe('budget_exceeded')
    }
  })

  it('returns 422 when the input guardrails refuse, before any model call', async () => {
    const sink = new MemoryLogSink()
    const result = await prepareGeneration(family.familyId, base(), {
      db: family.db,
      sink,
      inputGuard: {
        check: async () => ({
          decision: 'refuse' as const,
          category: 'weapons_instructions' as const,
          care_notes: null,
          min_recommended_age: 18,
          topic_key_hint: null,
          parent_message: null,
        }),
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.error.code).toBe('topic_refused')
      // GUARDRAILS §5: never echo the input, never name the layer that fired.
      expect(result.error.message).not.toContain('LEGO')
      expect(result.error.message.toLowerCase()).not.toMatch(/layer|l1|l2|blocklist/)
    }
    expect(sink.rows).toHaveLength(0)
  })

  it('maps too_mature_for_band onto its own code, so the UI can suggest an alternative', async () => {
    const result = await prepareGeneration(family.familyId, base(), {
      db: family.db,
      inputGuard: {
        check: async () => ({
          decision: 'refuse' as const,
          category: 'too_mature_for_band' as const,
          care_notes: null,
          min_recommended_age: 8,
          topic_key_hint: null,
          parent_message: "That one's a bit much for a 4-year-old.",
        }),
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.error.code).toBe('too_mature_for_band')
      expect(result.error.message).toBe("That one's a bit much for a 4-year-old.")
    }
  })

  it.skipIf(RECORDING)('returns 502 and keeps the quota when normalization cannot be read', async () => {
    // No fixture for this topic: normalizeTopic throws and the parent loses nothing.
    const quota = new RecordingQuota()
    const result = await prepareGeneration(
      family.familyId,
      { ...base(), topic_input: 'a topic with no recorded normalize fixture' },
      { db: family.db, sink: new MemoryLogSink(), quota },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(502)
      expect(result.error.code).toBe('generation_failed')
      expect(result.error.quota_consumed).toBe(false)
    }
    expect(quota.calls).toEqual(['preflight'])
  })
})
