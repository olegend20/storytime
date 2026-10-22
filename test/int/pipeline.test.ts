import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Issue #52: a first write the gateway cuts off. Each queued entry makes one streamed write
 * send `partial` to the parser and then fail the way streamModel reports a real drop
 * (VT-W1 proves that shape against the real SDK); an empty queue is the normal fixture replay.
 */
const drops = vi.hoisted(() => ({
  queue: [] as { partial: string; dropped?: boolean; hang?: boolean }[],
  signals: [] as (AbortSignal | undefined)[],
  /** Issue #76: whether each streamed write was marked as a continuation, and each rewrite call's variant. */
  continuations: [] as boolean[],
  rewriteVariants: [] as (string | undefined)[],
  /**
   * Issue #72: how many times the gateway drops the rewrite. The rewrite goes through
   * callModel, whose own drop loop (VT-R1/R2) is stood in for here: it makes
   * min(maxDrops, maxRetries) + 1 attempts, so the pipeline's options decide the outcome.
   */
  rewriteDrops: 0,
  rewriteAttempts: 0,
  rewriteRefuses: false,
  rewriteStatus: 0,
}))
vi.mock('@/lib/ai', async (orig) => {
  const actual = await orig<typeof import('@/lib/ai')>()
  return {
    ...actual,
    callModel: async (opts: Parameters<typeof actual.callModel>[0]) => {
      if (opts.purpose === 'rewrite') drops.rewriteVariants.push(opts.variant)
      if (opts.purpose === 'rewrite' && drops.rewriteRefuses) throw new actual.ModelRefusalError('stub', 'stub', null)
      if (opts.purpose === 'rewrite' && drops.rewriteStatus) {
        throw new actual.ModelCallError(`rewrite call to stub failed after 1 attempt(s): ${drops.rewriteStatus}`, {
          purpose: 'rewrite', model: 'stub', attempts: 1, retryable: false, status: drops.rewriteStatus,
        })
      }
      if (opts.purpose !== 'rewrite' || drops.rewriteDrops === 0) return actual.callModel(opts)
      const attempts = Math.min(opts.maxDrops ?? 1, opts.maxRetries ?? 2) + 1
      if (drops.rewriteDrops >= attempts) {
        drops.rewriteDrops -= attempts
        drops.rewriteAttempts += attempts
        throw new actual.ModelCallError(`rewrite call to stub failed after ${attempts} attempt(s): terminated`, {
          purpose: 'rewrite', model: 'stub', attempts, retryable: true,
        })
      }
      drops.rewriteAttempts += drops.rewriteDrops + 1
      drops.rewriteDrops = 0
      return actual.callModel(opts)
    },
    streamModel: async (opts: Parameters<typeof actual.streamModel>[0]) => {
      drops.continuations.push(opts.variant === 'continuation')
      const next = drops.queue.shift()
      if (!next) return actual.streamModel(opts)
      drops.signals.push(opts.signal)
      opts.onText?.(next.partial)
      // A write that thinks until it is stopped: it ends only when its signal aborts.
      if (next.hang) {
        return new Promise<never>((_, reject) =>
          opts.signal?.addEventListener('abort', () =>
            reject(new actual.ModelCallError(`${opts.purpose} stream to stub failed: aborted`, {
              purpose: opts.purpose, model: 'stub', attempts: 1, retryable: false, dropped: false,
            })),
          ),
        )
      }
      throw new actual.ModelCallError(`${opts.purpose} stream to stub failed: terminated`, {
        purpose: opts.purpose,
        model: 'stub',
        attempts: 1,
        retryable: false,
        dropped: next.dropped ?? true,
      })
    },
  }
})
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
import { initialStreamState, streamReducer } from '@/lib/client/generate'
import { getOrCreateSeries, loadBible, reloadBible, writeBible } from '@/lib/bible'
import {
  DAILY_STORY_LIMIT,
  storyWordCount,
  targetWords,
  wordCountWithinTolerance,
  type OutputSafetyReview,
  type OutputViolation,
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
import { buildContinuationPrompt, buildPrompt, type StorySoFar } from '@/lib/generate/prompt'
import { buildQualityReviewMessage, measuredForReview, QUALITY_REVIEW_THINKING_MAX_TOKENS } from '@/lib/quality/review'
import { AFTER_WRITE_MS, MAX_DROP_RETRIES, RETRY_MIN_MS, WRITER_MAX_TOKENS } from '@/lib/generate/pipeline'
import { MEND_MAX_TOKENS, cutViolations, mendUserMessage, passagesFor } from '@/lib/generate/mend'
import { STORY_OUTPUT_FORMAT } from '@/lib/generate/output-schema'
import { buildBibleUpdateMessage } from '@/lib/bible'
import { loadPrompt } from '@/lib/prompts'
import { modelForRole } from '@/lib/ai'
import { dataBlock as untrustedBlockRaw, untrustedBlock } from '@/lib/datablock'

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
    { name: 'Milo', age: 7, likes: ['LEGO', 'sharks'], role_notes: null },
    { name: 'Juno', age: 4, likes: ['dinosaurs'], role_notes: null },
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
        likes: c.first_name === 'Milo' ? ['LEGO', 'sharks'] : ['dinosaurs'],
        notes: null,
        reading_level: null,
      })),
      band: 'A',
      request: {
        children: [
          { name: 'Milo', age: 7, likes: ['LEGO', 'sharks'], notes: null },
          { name: 'Juno', age: 4, likes: ['dinosaurs'], notes: null },
        ],
        age_band: 'A',
        tones: ['funny', 'exciting'],
        length_minutes: 10,
        target_words: target,
        topic_label: topicLabel,
        topic_key: FIXTURE_TOPIC_KEY,
        avoid: [],
        care_notes: null,
        requested_characters: [],
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
      contentNotice: null,
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
    opts: { rewriteReasons?: string[]; story?: StoryOutput } = {},
  ): { story: StoryOutput; rewritten: StoryOutput } {
    const writer = modelForRole('writer')
    const helperModel = modelForRole('helper')
    const story = opts.story ?? stubStory()
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
        maxTokens: WRITER_MAX_TOKENS,
        thinking: 'adaptive',
        outputFormat: STORY_OUTPUT_FORMAT,
      }),
      JSON.stringify(story),
      { input_tokens: 1_400, cache_write_tokens: 4_200, output_tokens: 5_200 },
    )

    // 2. the quality review of that story
    stubFixture(
      'quality',
      callFixtureKey({
        model: modelForRole('quality_reviewer'),
        system: [{ text: loadPrompt('quality-review').body }],
        messages: [
          {
            role: 'user',
            content: buildQualityReviewMessage(
              story,
              run.request,
              FIXTURE_FACT_PACK,
              measuredForReview(story, run.request.age_band),
            ),
          },
        ],
        maxTokens: QUALITY_REVIEW_THINKING_MAX_TOKENS,
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
          maxTokens: WRITER_MAX_TOKENS,
          thinking: 'adaptive',
          outputFormat: STORY_OUTPUT_FORMAT,
        }),
        JSON.stringify(rewritten),
        { input_tokens: 1_500, cache_read_tokens: 4_200, output_tokens: 5_300 },
      )
      stubFixture(
        'quality',
        callFixtureKey({
          model: modelForRole('quality_reviewer'),
          system: [{ text: loadPrompt('quality-review').body }],
          messages: [
            {
              role: 'user',
              content: buildQualityReviewMessage(
                rewritten,
                rewriteRequest,
                FIXTURE_FACT_PACK,
                measuredForReview(rewritten, rewriteRequest.age_band),
              ),
            },
          ],
          maxTokens: QUALITY_REVIEW_THINKING_MAX_TOKENS,
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

    const info = vi.spyOn(console, 'info')
    const { events, result } = await collect(run, { db: family.db, sink, quota, now: () => FIXED_NOW })

    expect(result.status).toBe('ready')
    expect(result.writeCalls).toBe(1)
    // Issue #59: every finished request logs one outcome line, the SLA's numerator.
    expect(info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('outcome='))).toEqual([
      expect.stringMatching(new RegExp(`^\\[generate\\] outcome=ready band=\\S+ topic=${run.topicKey} secs=\\d+ writes=1$`)),
    ])
    info.mockRestore()

    // Exactly one writing-model call, plus the cheap steps around it.
    const purposes = sink.rows.map((r) => r.purpose)
    expect(purposes.filter((p) => p === 'write')).toHaveLength(1)
    expect(purposes.filter((p) => p === 'rewrite')).toHaveLength(0)
    expect(purposes).toContain('quality')

    const { data: row } = await family.db
      .from('stories')
      .select('status, word_count, quality, title, age_band, fact_pack_id, topic_key, content_notice')
      .eq('id', run.storyId)
      .single()
    const stored = row as {
      content_notice: string | null
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
    // Issue #27: an ordinary story carries no notice, on the row or in the stream.
    expect(stored.content_notice).toBeNull()
    expect(events.find((e) => e.type === 'meta')).toMatchObject({ content_notice: null })

    // F8 AC: quota touched exactly once, and only after the insert.
    expect(quota.calls).toEqual(['consumeQuota'])

    // SSE contract: meta first, then chapters, `done` last.
    // The fact cards go out first - before the writer has produced a word - then the title.
    expect(events[0]?.type).toBe('facts')
    const cards = events[0] as Extract<SseEvent, { type: 'facts' }>
    expect(cards.facts.length).toBeGreaterThan(0)
    expect(cards.facts.length).toBeLessThanOrEqual(12)
    expect(cards.topic_label).toBe(run.topicLabel)
    expect(events[1]?.type).toBe('meta')
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

  it('VT-C3: a story that borrows a character says so in the meta event and on the stored row', async () => {
    const run: PreparedGeneration = { ...(await prepared()), contentNotice: 'borrowed_character' }
    stubResponsesFor(run)

    const { events, result } = await collect(run, {
      db: family.db,
      sink: new MemoryLogSink(),
      quota: new RecordingQuota(),
      now: () => FIXED_NOW,
    })
    expect(result.status).toBe('ready')

    // In `meta`, so the reader shows it with the title, before a word of the story.
    const meta = events.find((e) => e.type === 'meta')
    expect(meta).toMatchObject({ type: 'meta', content_notice: 'borrowed_character' })

    const { data: row } = await family.db
      .from('stories')
      .select('content_notice')
      .eq('id', run.storyId)
      .single()
    expect((row as { content_notice: string | null }).content_notice).toBe('borrowed_character')
    if (result.bibleUpdate) await result.bibleUpdate
  })

  it('a character nobody asked for is not a violation (rule 7 retired), but the saved story carries the notice', async () => {
    const run = await prepared()
    expect(run.contentNotice).toBeNull()
    const plain = stubStory()
    const story = {
      ...plain,
      chapters: plain.chapters.map((c, i) =>
        i === 1 ? { ...c, text: `${c.text}\n\nThen Olaf waved at them from the window.` } : c,
      ),
    }
    stubResponsesFor(run, { story })

    const { events, result } = await collect(run, {
      db: family.db,
      sink: new MemoryLogSink(),
      quota: new RecordingQuota(),
      now: () => FIXED_NOW,
    })
    expect(result.status).toBe('ready')
    const { data: row } = await family.db
      .from('stories')
      .select('content_notice')
      .eq('id', run.storyId)
      .single()
    expect((row as { content_notice: string | null }).content_notice).toBe('borrowed_character')
    // The reader sees it on first view too: a second meta, before done (reviewer agent, PR #40).
    const metas = events.filter((e) => e.type === 'meta')
    expect(metas.map((m) => (m as { content_notice: string | null }).content_notice)).toEqual([null, 'borrowed_character'])
    expect(events.findIndex((e) => e === metas[1])).toBeLessThan(events.findIndex((e) => e.type === 'done'))
    if (result.bibleUpdate) await result.bibleUpdate
  })

  it('#58: firstDraftOnly stops at the gate - the draft comes back, nothing is reviewed, saved or counted', async () => {
    const run = await prepared()
    const { story } = stubResponsesFor(run)
    const sink = new MemoryLogSink()
    const quota = new RecordingQuota()
    const { events, result } = await collect(run, { db: family.db, sink, quota, now: () => FIXED_NOW, firstDraftOnly: true })

    expect(result.firstGated?.story.title).toBe(story.title)
    expect(result.firstGated?.request).toEqual(run.request)
    expect(result.quality).toBeNull()
    expect(sink.rows.map((r) => r.purpose)).toEqual(['write'])
    expect(events.some((e) => e.type === 'done')).toBe(false)
    expect(quota.calls).toEqual([])
    const { data: saved } = await family.db.from('stories').select('id').eq('id', run.storyId)
    expect(saved).toEqual([])
  })

  it('#58: a normal run reports the draft the gate reviewed first', async () => {
    const run = await prepared()
    const { story } = stubResponsesFor(run)
    const { result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
    expect(result.status).toBe('ready')
    expect(result.firstGated?.story.title).toBe(story.title)
    if (result.bibleUpdate) await result.bibleUpdate
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

    // Why the first draft was sent back is saved with the story - the measure "reduce the
    // rewrites" is impossible without it - and the local fixes are recorded with it.
    expect(result.quality?.first_attempt?.reasons).toEqual([
      'GUARDRAILS rule 3 breached',
      'output safety review returned safe: false',
      'scary_level 3 above band A limit',
    ])
    // The stub story's list says "pull-along duck" for a duck that was pulled along; that is
    // paraphrase, not a foreign term, so nothing was removed and nothing is recorded.
    expect(result.quality?.normalized).toBeUndefined()
  })

  /**
   * Issue #32 (VT-D2, VT-D3). The delivery ladder: a hard-rule breach is mended by one
   * helper call instead of a full rewrite, and a breach that survives the mend is cut, so
   * the parent gets a (flagged) book instead of nothing.
   */
  const SENTENCE = 'The glow grew brighter and brighter, and with a great big WHOOOOSH, the boys were pulled right inside the brick.'
  const REPLACEMENT = 'The glow grew brighter, and with a great big WHOOOOSH the boys were pulled gently inside the brick.'
  const hardViolation = (quote: string, rule = 7): OutputSafetyReview => ({
    safe: false,
    violations: [{ rule, quote, severity: 'hard' as const }],
    scary_level: 0,
    positive_portrayal: true,
    ending_safe: true,
  })
  const clean: OutputSafetyReview = { safe: true, violations: [], scary_level: 0, positive_portrayal: true, ending_safe: true }

  /** The mend call's fixture, plus the review and bible fixtures for the story it produces. */
  function stubMendFor(run: PreparedGeneration, story: StoryOutput, violations: OutputViolation[], edits: { chapter: number; find: string; replace: string }[]) {
    const helperModel = modelForRole('helper')
    stubFixture(
      'mend',
      callFixtureKey({
        model: helperModel,
        system: [{ text: loadPrompt('mend').body }],
        messages: [{ role: 'user', content: mendUserMessage(passagesFor(story, violations).passages) }],
        maxTokens: MEND_MAX_TOKENS,
      }),
      JSON.stringify({ edits }),
      { input_tokens: 1_200, output_tokens: 90 },
    )
    const mended: StoryOutput = {
      ...story,
      chapters: story.chapters.map((c, i) => {
        const edit = edits.find((e) => e.chapter === i)
        return edit ? { ...c, text: c.text.replace(edit.find, edit.replace) } : c
      }),
    }
    stubFixture(
      'quality',
      callFixtureKey({
        model: modelForRole('quality_reviewer'),
        system: [{ text: loadPrompt('quality-review').body }],
        messages: [{ role: 'user', content: buildQualityReviewMessage(mended, run.request, FIXTURE_FACT_PACK, measuredForReview(mended, run.request.age_band)) }],
        maxTokens: QUALITY_REVIEW_THINKING_MAX_TOKENS,
      }),
      JSON.stringify(STUB_PASSING_REVIEW),
      { input_tokens: 7_800, output_tokens: 120 },
    )
    stubFixture(
      'bible_update',
      callFixtureKey({
        model: helperModel,
        system: [{ text: loadPrompt('bible-update').body }],
        messages: [{ role: 'user', content: buildBibleUpdateMessage(BIBLE_AT_START, mended, { topic: run.topicLabel, storyId: run.storyId, date: '2026-09-27', tones: run.request.tones }) }],
        maxTokens: 4_000,
      }),
      JSON.stringify(stubBible(BIBLE_AT_START.children)),
      { input_tokens: 4_600, output_tokens: 640 },
    )
    return mended
  }

  it('VT-D2: a hard-rule breach on attempt 1 is mended by one helper call, not rewritten', async () => {
    const run = await prepared()
    const { story } = stubResponsesFor(run)
    const violations: OutputViolation[] = [{ rule: 7, quote: SENTENCE.slice(0, 40), severity: 'hard' }]
    const mended = stubMendFor(run, story, violations, [{ chapter: 0, find: SENTENCE, replace: REPLACEMENT }])
    let reviewCall = 0
    const safetyReviewer = {
      review: async (): Promise<OutputSafetyReview> => (++reviewCall === 1 ? hardViolation(SENTENCE.slice(0, 40)) : clean),
    }
    const sink = new MemoryLogSink()
    const { result } = await collect(run, { db: family.db, sink, quota: new RecordingQuota(), safetyReviewer, now: () => FIXED_NOW })

    expect(result.status).toBe('ready')
    expect(result.writeCalls).toBe(1)
    const purposes = sink.rows.map((r) => r.purpose)
    expect(purposes.filter((p) => p === 'rewrite')).toHaveLength(0)
    expect(purposes.filter((p) => p === 'mend')).toHaveLength(1)
    expect(reviewCall).toBe(2)
    expect(result.quality?.mended).toEqual({ edits: 1, cut: 0, rules: [7] })
    expect(result.quality?.first_attempt?.reasons).toEqual(['GUARDRAILS rule 7 breached', 'output safety review returned safe: false'])
    // The sentence changed; every other sentence is byte-identical.
    expect(result.story?.chapters[0]!.text).toBe(mended.chapters[0]!.text)
    expect(result.story?.chapters.slice(1)).toEqual(story.chapters.slice(1))
    const { data: row } = await family.db.from('stories').select('status, content').eq('id', run.storyId).single()
    expect((row as { status: string }).status).toBe('ready')
    expect(JSON.stringify((row as { content: unknown }).content)).toContain(REPLACEMENT)
    if (result.bibleUpdate) await result.bibleUpdate
  })

  it('VT-D3: a breach that survives the mend is cut, and the story ships flagged instead of discarded', async () => {
    const run = await prepared()
    stubResponsesFor(run, { rewriteReasons: ['GUARDRAILS rule 10 breached', 'output safety review returned safe: false', 'scary_level 2 above band A limit'] })
    // Attempt 1 fails on a mix (so the full rewrite runs); the rewrite breaches too, and the
    // mend call returns nothing usable: that is the case that used to be a discard.
    const quote = SENTENCE.slice(0, 40)
    const rewritten = stubRewrittenStory()
    const rewrittenQuote = rewritten.chapters[0]!.text.split(/(?<=[.!?])\s+/)[0]!
    const rewrittenViolations: OutputViolation[] = [{ rule: 10, quote: rewrittenQuote.slice(0, 30), severity: 'hard' }]
    stubMendFor(run, rewritten, rewrittenViolations, [])
    // The cut story goes through the whole gate again: its review and bible fixtures.
    const afterCut = cutViolations(rewritten, rewrittenViolations)
    expect(afterCut.complete).toBe(true)
    stubMendFor(run, afterCut.story, [], [])
    let reviewCall = 0
    const safetyReviewer = {
      review: async (story: StoryOutput): Promise<OutputSafetyReview> => {
        reviewCall += 1
        if (reviewCall === 1) return { ...hardViolation(quote, 10), scary_level: 2 }
        // The rewrite breaches too, on its own first sentence - until that sentence is gone.
        return story.chapters[0]!.text.includes(rewrittenQuote) ? hardViolation(rewrittenQuote.slice(0, 30), 10) : clean
      },
    }
    const sink = new MemoryLogSink()
    const quota = new RecordingQuota()
    const { events, result } = await collect(run, { db: family.db, sink, quota, safetyReviewer, now: () => FIXED_NOW })

    expect(result.status).toBe('flagged')
    expect(result.writeCalls).toBe(2)
    expect(result.quality?.outcome).toBe('flagged')
    expect(result.quality?.mended).toEqual({ edits: 0, cut: 1, rules: [10] })
    // The record describes the cut story, gate and safety review included.
    expect(result.quality?.hard_violations).toEqual([])
    expect(result.quality?.safety?.safe).toBe(true)
    expect(result.quality?.word_count).toBe(result.wordCount)
    expect(result.quality?.first_attempt?.reasons[0]).toBe('GUARDRAILS rule 10 breached')
    expect(reviewCall).toBe(3)
    // The offending sentence is gone; the story is saved and announced, quota consumed.
    expect(result.story?.chapters[0]!.text).not.toContain(rewrittenQuote)
    expect(result.story?.chapters[0]!.text.length).toBeGreaterThan(0)
    expect(events.at(-1)?.type).toBe('done')
    const { data: row } = await family.db.from('stories').select('status').eq('id', run.storyId).single()
    expect((row as { status: string }).status).toBe('flagged')
    // A book was delivered, so it counts against the day: the change from §4.1's discard.
    expect(quota.calls).toEqual(['consumeQuota'])
    if (result.bibleUpdate) await result.bibleUpdate
  })

  /**
   * Issue #32, rung 3 (VT-D4): an unusable first write - here, prose with no JSON that the
   * repair cannot save - is retried once, one length tier shorter, and the parent gets that
   * story instead of nothing.
   */
  it('VT-D4: an unusable write is retried one tier shorter, and that story is the one saved', async () => {
    const run = await prepared()
    const writer = modelForRole('writer')
    const helperModel = modelForRole('helper')
    // Everything the happy path needs (the bible-update fixtures for the rewritten story too).
    stubResponsesFor(run)
    // 1. the streamed write returns something that is not a story...
    const garbage = 'Once upon a time - and then the response stopped'
    const writePrompt = buildPrompt({ request: run.request, bible: BIBLE_AT_START, factPack: FIXTURE_FACT_PACK })
    stubFixture(
      'write',
      streamFixtureKey({ model: writer, system: writePrompt.system, messages: writePrompt.messages, maxTokens: WRITER_MAX_TOKENS, thinking: 'adaptive', outputFormat: STORY_OUTPUT_FORMAT }),
      garbage,
      { input_tokens: 1_400, output_tokens: 32_000 },
    )
    // 2. ...and the one repair attempt cannot save it.
    stubFixture(
      'repair',
      callFixtureKey({
        model: helperModel,
        system: [{ text: loadPrompt('repair').body }],
        messages: [{ role: 'user', content: [untrustedBlockRaw('payload', garbage), untrustedBlockRaw('validation_errors', '- no JSON object found in the response'), 'Return the corrected JSON object only.'].join('\n\n') }],
        maxTokens: 16_000,
      }),
      JSON.stringify({ error: 'irreparable', missing: ['chapters'] }),
    )
    // 3. the retry, at five minutes instead of ten, returns a story.
    const shorter = { ...run.request, length_minutes: 5 as const, target_words: targetWords({ band: 'A', minutes: 5 }) }
    const retryPrompt = buildPrompt({ request: shorter, bible: BIBLE_AT_START, factPack: FIXTURE_FACT_PACK })
    const retried = stubRewrittenStory()
    stubFixture(
      'rewrite',
      callFixtureKey({ model: writer, system: retryPrompt.system, messages: retryPrompt.messages, maxTokens: WRITER_MAX_TOKENS, thinking: 'adaptive', outputFormat: STORY_OUTPUT_FORMAT }),
      JSON.stringify(retried),
      { input_tokens: 1_500, cache_read_tokens: 4_200, output_tokens: 5_300 },
    )
    stubFixture(
      'quality',
      callFixtureKey({
        model: modelForRole('quality_reviewer'),
        system: [{ text: loadPrompt('quality-review').body }],
        messages: [{ role: 'user', content: buildQualityReviewMessage(retried, shorter, FIXTURE_FACT_PACK, measuredForReview(retried, 'A')) }],
        maxTokens: QUALITY_REVIEW_THINKING_MAX_TOKENS,
      }),
      JSON.stringify(STUB_PASSING_REVIEW),
    )

    const sink = new MemoryLogSink()
    const quota = new RecordingQuota()
    const { events, result } = await collect(run, { db: family.db, sink, quota, now: () => FIXED_NOW })

    expect(['ready', 'flagged']).toContain(result.status)
    expect(result.writeCalls).toBe(2)
    expect(sink.rows.filter((r) => r.purpose === 'rewrite')).toHaveLength(1)
    expect(result.story?.title).toBe(retried.title)
    expect(result.quality?.first_attempt?.reasons).toEqual(['output unusable; retried 10 -> 5 minutes'])
    // The first-write prompt again: its own Understudy workload, not the rewrite's (#76).
    expect(drops.rewriteVariants.at(-1)).toBe('shorter')
    expect(result.quality?.first_attempt?.failures[0]?.detail).toMatch(/story output unusable: repair_failed/)
    // The book is the shorter one, saved as such, delivered in `done`, and it counts.
    const { data: row } = await family.db.from('stories').select('length_minutes, title').eq('id', run.storyId).single()
    expect(row).toMatchObject({ length_minutes: 5, title: retried.title })
    expect(events.at(-1)?.type).toBe('done')
    expect(quota.calls).toEqual(['consumeQuota'])
    if (result.bibleUpdate) await result.bibleUpdate
  })

  it('VT-D4: with too little time left before the request deadline, no retry starts - a clean error instead', async () => {
    const run = await prepared()
    const writer = modelForRole('writer')
    stubResponsesFor(run)
    const garbage = 'Once upon a time - and then the response stopped'
    const writePrompt = buildPrompt({ request: run.request, bible: BIBLE_AT_START, factPack: FIXTURE_FACT_PACK })
    stubFixture(
      'write',
      streamFixtureKey({ model: writer, system: writePrompt.system, messages: writePrompt.messages, maxTokens: WRITER_MAX_TOKENS, thinking: 'adaptive', outputFormat: STORY_OUTPUT_FORMAT }),
      garbage,
    )
    stubFixture(
      'repair',
      callFixtureKey({
        model: modelForRole('helper'),
        system: [{ text: loadPrompt('repair').body }],
        messages: [{ role: 'user', content: [untrustedBlockRaw('payload', garbage), untrustedBlockRaw('validation_errors', '- no JSON object found in the response'), 'Return the corrected JSON object only.'].join('\n\n') }],
        maxTokens: 16_000,
      }),
      JSON.stringify({ error: 'irreparable' }),
    )
    const sink = new MemoryLogSink()
    const { events, result } = await collect(run, {
      db: family.db, sink, quota: new RecordingQuota(), now: () => FIXED_NOW,
      deadlineMs: Date.now() + RETRY_MIN_MS - 1_000,
    })
    expect(result.status).toBe('failed')
    expect(result.writeCalls).toBe(1)
    expect(sink.rows.filter((r) => r.purpose === 'rewrite')).toHaveLength(0)
    // The parent is told, rather than left with a stream that just stops.
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'generation_failed', quota_consumed: false })
  })

  describe('issue #52: a first write cut off partway', () => {
    const META_ONLY = '{"title":"The Lost Signal","subtitle":null,"chapters":['
    afterEach(() => {
      drops.queue.length = 0
      drops.signals.length = 0
      vi.restoreAllMocks()
    })

    it('VT-W2: dropped before any chapter reached the parent, it is written again, streamed, once', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      drops.queue.push({ partial: META_ONLY })
      const sink = new MemoryLogSink()
      const quota = new RecordingQuota()
      const { events, result } = await collect(run, { db: family.db, sink, quota, now: () => FIXED_NOW })

      expect(result.status).toBe('ready')
      expect(result.writeCalls).toBe(2)
      expect(result.story?.title).toBe(story.title)
      // The parent saw the fact cards, a title, then the real story's title and its chapters.
      const metas = events.filter((e) => e.type === 'meta') as Extract<SseEvent, { type: 'meta' }>[]
      expect(metas.map((m) => m.title)).toEqual(['The Lost Signal', story.title])
      const starts = events.filter((e) => e.type === 'chapter_start')
      expect(starts).toHaveLength(story.chapters.length)
      expect(events.at(-1)?.type).toBe('done')
      expect(quota.calls).toEqual(['consumeQuota'])
      if (result.bibleUpdate) await result.bibleUpdate
    })

    // VT-W3 (a drop after a chapter was sent fails cleanly) is superseded by #74 below: the
    // rest of the story is written instead.

    it('VT-W4: with less than RETRY_MIN_MS before the deadline, no second write starts', async () => {
      const run = await prepared()
      stubResponsesFor(run)
      drops.queue.push({ partial: META_ONLY })
      const { events, result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW,
        deadlineMs: Date.now() + RETRY_MIN_MS - 1_000,
      })
      expect(result.status).toBe('failed')
      expect(result.writeCalls).toBe(1)
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'generation_failed' })
    })

    it('VT-W5: a failure that is not a drop is never retried (the drop limit: #72 below)', async () => {
      const other = await prepared()
      stubResponsesFor(other)
      drops.queue.push({ partial: '', dropped: false })
      const notDrop = await collect(other, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(notDrop.result.status).toBe('failed')
      expect(notDrop.result.writeCalls).toBe(1)
    })

    it('VT-W6: the second write is cut off in time for the gate and the save, and the parent gets an error', async () => {
      const run = await prepared()
      stubResponsesFor(run)
      // Stand in for the timer so the test need not wait minutes: record the bound, abort by hand.
      const stop = new AbortController()
      const bounds: number[] = []
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        bounds.push(ms)
        return stop.signal
      })
      drops.queue.push({ partial: META_ONLY }, { partial: '', hang: true })
      const deadlineMs = Date.now() + 400_000
      const pending = collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW, deadlineMs,
      })
      await vi.waitFor(() => expect(drops.signals).toHaveLength(2))
      expect(drops.signals[0]).toBeUndefined()
      expect(drops.signals[1]).toBe(stop.signal)
      expect(bounds.some((ms) => ms <= 400_000 - AFTER_WRITE_MS && ms > 400_000 - AFTER_WRITE_MS - 10_000)).toBe(true)
      stop.abort()
      const { events, result } = await pending
      expect(result.status).toBe('failed')
      expect(result.writeCalls).toBe(2)
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'generation_failed', quota_consumed: false })
    })
  })

  describe('issue #74: a write dropped after chapters were shown is finished, not lost', () => {
    afterEach(() => {
      drops.queue.length = 0
      drops.signals.length = 0
      vi.restoreAllMocks()
    })

    /** The story's JSON up to `whole` complete chapters, then `half` of the next chapter's text. */
    function cutAfter(story: StoryOutput, whole: number, half = ''): string {
      const head = JSON.stringify({ title: story.title, subtitle: story.subtitle, chapters: story.chapters.slice(0, whole) })
      const open = head.slice(0, -2) // drop the closing "]}"
      if (half === '' && whole === 0) return open
      const next = story.chapters[whole]!
      const cut = `{"heading":${JSON.stringify(next.heading)},"text":${JSON.stringify(half).slice(0, -1)}`
      return half === '' ? open : `${open}${whole > 0 ? ',' : ''}${cut}`
    }

    /** What the parent had whole when the write dropped. */
    function soFar(story: StoryOutput, whole: number, chaptersComplete = false): StorySoFar {
      return {
        title: story.title,
        subtitle: story.subtitle,
        chapters: story.chapters.slice(0, whole).map((c) => ({ heading: c.heading, text: c.text, shout_line: c.shout_line })),
        chaptersComplete,
      }
    }

    /** The writer's reply to the continuation: by default the rest of the same story. */
    function stubContinuation(
      run: PreparedGeneration,
      story: StoryOutput,
      whole: number,
      opts: { chaptersComplete?: boolean; reply?: StoryOutput['chapters'] } = {},
    ): void {
      const rest = buildContinuationPrompt({
        request: run.request, bible: BIBLE_AT_START, factPack: FIXTURE_FACT_PACK, soFar: soFar(story, whole, opts.chaptersComplete),
      })
      stubFixture(
        'write',
        streamFixtureKey({
          model: modelForRole('writer'),
          system: rest.system,
          messages: rest.messages,
          maxTokens: WRITER_MAX_TOKENS,
          thinking: 'adaptive',
          outputFormat: STORY_OUTPUT_FORMAT,
        }),
        JSON.stringify({ ...story, chapters: opts.reply ?? story.chapters.slice(whole) }),
        { input_tokens: 1_900, cache_read_tokens: 4_200, output_tokens: 3_900 },
      )
    }

    it('VT-RS1: dropped halfway through chapter 2, the rest is written and the whole story saved', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      stubContinuation(run, story, 1)
      drops.queue.push({ partial: cutAfter(story, 1, 'Half of chapter two, then the line') })
      const sink = new MemoryLogSink()
      const quota = new RecordingQuota()
      const { events, result } = await collect(run, { db: family.db, sink, quota, now: () => FIXED_NOW })

      expect(result.status).toBe('ready')
      expect(result.writeCalls).toBe(2)
      expect(result.story).toEqual(story)
      // One title: the story was continued, never started over.
      expect(events.filter((e) => e.type === 'meta')).toHaveLength(1)
      expect(sink.rows.filter((r) => r.purpose === 'write')).toHaveLength(1)
      expect(quota.calls).toEqual(['consumeQuota'])
      expect(events.at(-1)?.type).toBe('done')
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-UW2 (#76): the continuation is tagged as its own workload, the first write is not', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      stubContinuation(run, story, 1)
      drops.queue.push({ partial: cutAfter(story, 1, 'Half') })
      drops.continuations.length = 0
      const { result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')
      expect(drops.continuations).toEqual([false, true])
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS2: the half chapter is cleared on the page, then written again - never duplicated', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      stubContinuation(run, story, 1)
      drops.queue.push({ partial: cutAfter(story, 1, 'Half of chapter two') })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')

      const starts = events.filter((e): e is Extract<SseEvent, { type: 'chapter_start' }> => e.type === 'chapter_start')
      expect(starts.map((e) => [e.index, e.heading])).toEqual([
        [0, story.chapters[0]!.heading],
        [1, story.chapters[1]!.heading],
        [1, ''], // cleared: the page shows "Still writing…"
        ...story.chapters.slice(1).map((c, i) => [i + 1, c.heading]),
      ])
      // Played through the page's own reducer, every chapter reads exactly as saved.
      const page = events.reduce((state, event) => streamReducer(state, { kind: 'event', event }), initialStreamState)
      const streamed = events
        .slice(0, events.findIndex((e) => e.type === 'done'))
        .reduce((state, event) => streamReducer(state, { kind: 'event', event }), initialStreamState)
      expect(streamed.chapters.map((c) => c.text)).toEqual(story.chapters.map((c) => c.text))
      expect(page.phase).toBe('done')
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS3: a continuation that drops is continued again, up to MAX_DROP_RETRIES drops in all', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      stubContinuation(run, story, 1)
      drops.queue.push({ partial: cutAfter(story, 1, 'Half') }, { partial: '' })
      const ok = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(ok.result.status).toBe('ready')
      expect(ok.result.writeCalls).toBe(3)
      expect(ok.result.story).toEqual(story)
      if (ok.result.bibleUpdate) await ok.result.bibleUpdate

      const again = await prepared()
      stubResponsesFor(again)
      drops.queue.push({ partial: cutAfter(story, 1, 'Half') }, ...Array.from({ length: MAX_DROP_RETRIES }, () => ({ partial: '' })))
      const lost = await collect(again, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(lost.result.status).toBe('failed')
      expect(lost.result.writeCalls).toBe(MAX_DROP_RETRIES + 1)
      expect(lost.events.at(-1)).toMatchObject({ type: 'error', code: 'generation_failed', quota_consumed: false })
    })

    it('VT-RS4: without RETRY_MIN_MS left, nothing more is written - a clean error, no partial save', async () => {
      const run = await prepared()
      stubResponsesFor(run)
      drops.queue.push({ partial: cutAfter(stubStory(), 1, 'Half') })
      const quota = new RecordingQuota()
      const { events, result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota, now: () => FIXED_NOW,
        deadlineMs: Date.now() + RETRY_MIN_MS - 1_000,
      })
      expect(result.status).toBe('failed')
      expect(result.writeCalls).toBe(1)
      expect(result.story).toBeNull()
      expect(quota.calls).toEqual([])
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'generation_failed', quota_consumed: false })
    })

    it('VT-RS5: dropped before any chapter, it is still written again from the start (#72), not continued', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      drops.queue.push({ partial: cutAfter(story, 0) })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')
      expect(result.writeCalls).toBe(2)
      expect(events.filter((e) => e.type === 'chapter_start' && e.heading === '')).toHaveLength(0)
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS5: dropped while chapter 1 is half shown, the whole story is continued from chapter 1', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      stubContinuation(run, story, 0)
      drops.queue.push({ partial: cutAfter(story, 0, 'Half of the first') })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')
      expect(result.story).toEqual(story)
      expect(events.filter((e) => e.type === 'meta')).toHaveLength(1)
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS6: the continuation holds only this story\'s whole chapters - not the half one, never another story', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      stubContinuation(run, story, 2)
      drops.queue.push({ partial: cutAfter(story, 2, 'UNFINISHED-HALF-CHAPTER') })
      const { result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')
      // Matching the recorded continuation key proves the exact prompt: whole chapters 1-2 only.
      const rest = buildContinuationPrompt({ request: run.request, bible: BIBLE_AT_START, factPack: FIXTURE_FACT_PACK, soFar: soFar(story, 2) })
      const user = JSON.stringify(rest.messages)
      expect(user).not.toContain('UNFINISHED-HALF-CHAPTER')
      expect(user).not.toContain(story.chapters[2]!.text.slice(0, 40))
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS8: cut after the last chapter, only the ending is asked for - no "Still writing…", no extra chapter', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      // Even a reply that adds a chapter is held to the chapters the page already has.
      stubContinuation(run, story, story.chapters.length, { chaptersComplete: true, reply: [story.chapters[0]!] })
      const whole = JSON.stringify({ title: story.title, subtitle: story.subtitle, chapters: story.chapters })
      drops.queue.push({ partial: `${whole.slice(0, -1)},"ending_line":"And so` })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')
      expect(result.story).toEqual(story)
      expect(events.filter((e) => e.type === 'chapter_start' && e.heading === '')).toHaveLength(0)
      expect(events.filter((e) => e.type === 'chapter_start')).toHaveLength(story.chapters.length)
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS8: an ending-only continuation that drops is continued as ending-only again', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      stubContinuation(run, story, story.chapters.length, { chaptersComplete: true })
      const whole = JSON.stringify({ title: story.title, subtitle: story.subtitle, chapters: story.chapters })
      // The second drop comes before the continuation's own `"chapters":[]` closes.
      drops.queue.push({ partial: `${whole.slice(0, -1)},"ending_line":"And so` }, { partial: '' })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')
      expect(result.writeCalls).toBe(3)
      expect(result.story).toEqual(story)
      expect(events.filter((e) => e.type === 'chapter_start' && e.heading === '')).toHaveLength(0)
      expect(events.filter((e) => e.type === 'chapter_start')).toHaveLength(story.chapters.length)
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS9: a continuation that repeats chapters already shown is neither shown nor saved twice', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      // The writer starts the story over instead of continuing it.
      stubContinuation(run, story, 2, { reply: story.chapters })
      drops.queue.push({ partial: cutAfter(story, 2, 'Half') })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')
      expect(result.story).toEqual(story)
      const starts = events.filter((e): e is Extract<SseEvent, { type: 'chapter_start' }> => e.type === 'chapter_start' && e.heading !== '')
      // Chapters 1-2 and the half chapter 3 from the first write; then 3 onwards, once each.
      expect(starts.map((e) => e.index)).toEqual([0, 1, 2, ...story.chapters.slice(2).map((_, i) => i + 2)])
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS10: a chapter the writer leaves without a heading never looks like a cleared one on the page', async () => {
      const run = await prepared()
      const story = stubStory()
      story.chapters[1] = { ...story.chapters[1]!, heading: '' }
      stubResponsesFor(run, { story })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(events.filter((e) => e.type === 'chapter_start' && e.heading === '')).toHaveLength(0)
      expect(events).toContainEqual({ type: 'chapter_start', index: 1, heading: 'Chapter 2' })
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-RS7: the forced-drop eval cuts the first write after N whole chapters and the story is continued', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      stubContinuation(run, story, 1)
      const { events, result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW,
        forceDropAfterChapters: 1,
      })
      expect(result.status).toBe('ready')
      expect(result.writeCalls).toBe(2)
      expect(result.story).toEqual(story)
      expect(events.filter((e) => e.type === 'chapter_start' && e.heading === '')).toHaveLength(1)
      if (result.bibleUpdate) await result.bibleUpdate
    })
  })

  describe('issue #72: a dropped connection no longer loses a story', () => {
    const META_ONLY = '{"title":"The Lost Signal","subtitle":null,"chapters":['
    afterEach(() => {
      drops.queue.length = 0
      drops.signals.length = 0
      drops.rewriteDrops = 0
      drops.rewriteAttempts = 0
      drops.rewriteRefuses = false
      drops.rewriteStatus = 0
    })
    const tooScaryOnce = () => {
      let calls = 0
      return {
        review: async (): Promise<OutputSafetyReview> =>
          ++calls === 1 ? { ...clean, scary_level: 2 } : clean,
      }
    }

    /** A first draft sent back for a quality failure only - too short - like 10-19's dinosaurs. */
    const tooShort = () => {
      const base = stubStory()
      return stubStory({
        chapters: base.chapters.map((c) => ({ ...c, text: c.text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ') })),
      })
    }
    const alwaysClean = { review: async (): Promise<OutputSafetyReview> => clean }

    it('VT-F1: a rewrite that drops on every attempt falls back to attempt 1, flagged and saved', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run, { story: tooShort() })
      drops.rewriteDrops = 99
      const quota = new RecordingQuota()
      const { events, result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota, safetyReviewer: alwaysClean, now: () => FIXED_NOW,
      })

      expect(result.status).toBe('flagged')
      expect(result.writeCalls).toBe(2)
      expect(drops.rewriteAttempts).toBe(MAX_DROP_RETRIES + 1)
      expect(result.story?.title).toBe(story.title)
      expect(result.quality?.rewrite_reasons).toContain('rewrite output unusable: rewrite_failed:dropped')
      expect(result.quality?.first_attempt?.failures.map((f) => f.check)).toContain('word_count_in_range')
      expect(events.at(-1)?.type).toBe('done')
      const { data: row } = await family.db.from('stories').select('status').eq('id', run.storyId).single()
      expect((row as { status: string }).status).toBe('flagged')
      expect(quota.calls).toEqual(['consumeQuota'])
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-F2: a fallback that still holds a hard breach goes down the ladder - cut, regated, flagged', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run, {
        rewriteReasons: ['GUARDRAILS rule 10 breached', 'output safety review returned safe: false', 'scary_level 2 above band A limit'],
      })
      const quote = SENTENCE.slice(0, 40)
      const violations: OutputViolation[] = [{ rule: 10, quote, severity: 'hard' }]
      stubMendFor(run, story, violations, [])
      const afterCut = cutViolations(story, violations)
      expect(afterCut.complete).toBe(true)
      stubMendFor(run, afterCut.story, [], [])
      let reviewCall = 0
      const safetyReviewer = {
        review: async (s: StoryOutput): Promise<OutputSafetyReview> => {
          reviewCall += 1
          // A hard breach only: the in-place mend finds no edit, so the full rewrite runs.
          if (reviewCall === 1) return hardViolation(quote, 10)
          return JSON.stringify(s).includes(SENTENCE) ? hardViolation(quote, 10) : clean
        },
      }
      drops.rewriteDrops = 99
      const { result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), safetyReviewer, now: () => FIXED_NOW,
      })

      expect(result.status).toBe('flagged')
      expect(result.quality?.mended).toEqual({ edits: 0, cut: 1, rules: [10] })
      expect(result.quality?.hard_violations).toEqual([])
      expect(result.quality?.safety?.safe).toBe(true)
      expect(JSON.stringify(result.story)).not.toContain(SENTENCE)
      expect(reviewCall).toBe(2)
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-F2: a fallback whose breach survives the ladder is still discarded', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run, {
        rewriteReasons: ['GUARDRAILS rule 10 breached', 'output safety review returned safe: false', 'scary_level 2 above band A limit'],
      })
      // A quote the ladder cannot place: nothing to mend, nothing to cut.
      const violations: OutputViolation[] = [{ rule: 10, quote: 'a line that is nowhere in the story', severity: 'hard' }]
      stubMendFor(run, story, violations, [])
      const safetyReviewer = {
        review: async (): Promise<OutputSafetyReview> => hardViolation(violations[0]!.quote, 10),
      }
      drops.rewriteDrops = 99
      const quota = new RecordingQuota()
      const { events, result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota, safetyReviewer, now: () => FIXED_NOW,
      })
      expect(result.status).toBe('discarded')
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'generation_failed', quota_consumed: false })
      expect(quota.calls).toEqual([])
    })

    it('VT-F3: a refusal on the rewrite still fails the request - no fallback', async () => {
      const run = await prepared()
      stubResponsesFor(run, { rewriteReasons: ['scary_level 2 above band A limit'] })
      drops.rewriteRefuses = true
      const { result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), safetyReviewer: tooScaryOnce(), now: () => FIXED_NOW,
      })
      expect(result.status).toBe('failed')
      expect(result.reason).toMatch(/ModelRefusalError/)
    })

    it('VT-F4: attempt 1 sent back as too scary for its band is not delivered on a lost rewrite', async () => {
      const run = await prepared()
      stubResponsesFor(run)
      drops.rewriteDrops = 99
      const quota = new RecordingQuota()
      const { events, result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota, safetyReviewer: tooScaryOnce(), now: () => FIXED_NOW,
      })
      expect(result.status).toBe('failed')
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'generation_failed', quota_consumed: false })
      expect(quota.calls).toEqual([])
    })

    it('VT-F5: a rewrite failing with a 4xx of our own making (wrong model id) fails loudly - no fallback', async () => {
      const run = await prepared()
      stubResponsesFor(run, { story: tooShort() })
      drops.rewriteStatus = 404
      const { result } = await collect(run, {
        db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), safetyReviewer: alwaysClean, now: () => FIXED_NOW,
      })
      expect(result.status).toBe('failed')
      expect(result.reason).toBe('ModelCallError status=404')
    })

    it('VT-W7: a first write dropped twice before any chapter is written a third time and saved', async () => {
      const run = await prepared()
      const { story } = stubResponsesFor(run)
      drops.queue.push({ partial: META_ONLY }, { partial: '' })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('ready')
      expect(result.writeCalls).toBe(3)
      expect(result.story?.title).toBe(story.title)
      expect(events.at(-1)?.type).toBe('done')
      if (result.bibleUpdate) await result.bibleUpdate
    })

    it('VT-W5: a first write dropped MAX_DROP_RETRIES + 1 times fails cleanly', async () => {
      const run = await prepared()
      stubResponsesFor(run)
      for (let i = 0; i <= MAX_DROP_RETRIES; i += 1) drops.queue.push({ partial: '' })
      const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
      expect(result.status).toBe('failed')
      expect(result.writeCalls).toBe(MAX_DROP_RETRIES + 1)
      expect(drops.queue).toHaveLength(0)
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'generation_failed', quota_consumed: false })
    })

    /**
     * VT-DB, the drop bench: the nine runs that dropped in the 2026-10-19 live eval, with their
     * exact patterns from generation_logs (12 drops). One retry saved 6 of them; issue #72's
     * target is all 9. Fixtures stand in for the model, so this measures the plumbing, free.
     */
    it('VT-DB: the drop bench - every run that dropped on 2026-10-19 now saves a story', async () => {
      const RUNS = [
        { at: '16:49', write: 1, rewrite: 0 },
        { at: '17:01', write: 0, rewrite: 1 },
        { at: '17:28', write: 0, rewrite: 2 }, // space race, band C - lost
        { at: '17:59', write: 0, rewrite: 1 },
        { at: '18:46', write: 2, rewrite: 0 }, // volcanoes, band B - lost
        { at: '18:51', write: 1, rewrite: 0 },
        { at: '19:38', write: 0, rewrite: 2 }, // dinosaurs, band C - lost
        { at: '19:42', write: 1, rewrite: 0 },
        { at: '19:57', write: 0, rewrite: 1 },
      ]
      const saved: string[] = []
      for (const r of RUNS) {
        const run = await prepared()
        stubResponsesFor(run, r.rewrite > 0 ? { rewriteReasons: ['scary_level 2 above band A limit'] } : {})
        for (let i = 0; i < r.write; i += 1) drops.queue.push({ partial: i === 0 ? META_ONLY : '' })
        drops.rewriteDrops = r.rewrite
        const { result } = await collect(run, {
          db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW,
          ...(r.rewrite > 0 ? { safetyReviewer: tooScaryOnce() } : {}),
        })
        if (result.status === 'ready' || result.status === 'flagged') saved.push(r.at)
        if (result.bibleUpdate) await result.bibleUpdate
        drops.queue.length = 0
        drops.rewriteDrops = 0
        // Each run starts from the same bible, as each run in the eval did.
        await writeBible(await loadBible(seriesId, { db: family.db }), BIBLE_AT_START, family.db)
      }
      console.info(`[drop bench] ${saved.length}/${RUNS.length} saved`)
      expect(saved).toEqual(RUNS.map((r) => r.at))
    })
  })

  it('a write that fails before any event is reported as an error event, not a dropped stream', async () => {
    // No fact cards (no pack) and no recorded write: the first thing the run can send is the
    // failure. The route opens the stream before the run, so this must be an `error` event -
    // an ended stream would read on the page as "your story is still being made".
    const run: PreparedGeneration = { ...(await prepared('a topic with no recorded write')), factPack: null }
    const { events, result } = await collect(run, { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), now: () => FIXED_NOW })
    expect(result.status).toBe('failed')
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'generation_failed', quota_consumed: false })])
  })

  it('F7 VT: two consecutive failures flag the story - still saved, still shown', async () => {
    const run = await prepared()
    stubResponsesFor(run, { rewriteReasons: ['scary_level 2 above band A limit'] })
    const alwaysTooScary = {
      // Above band A's scary limit of 1 both times, but no HARD rule breach:
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

    const warn = vi.spyOn(console, 'warn')
    const { events, result } = await collect(run, {
      db: family.db,
      sink: new MemoryLogSink(),
      quota,
      safetyReviewer: alwaysHard,
      now: () => FIXED_NOW,
    })

    expect(result.status).toBe('discarded')
    // Issue #59: the discard was silent in production; it now names the rules that caused it.
    const outcomes = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('outcome='))
    warn.mockRestore()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatch(/^\[generate\] outcome=discarded .* writes=2 reason=rules 3\b/)
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

  it.skipIf(RECORDING)('F6 VT: a failed write is an error event with quota_consumed: false - no story row, no quota', async () => {
    // No recorded fixture for this prompt, so the write fails without producing a byte.
    // Since the fact cards (2026-09-29) the stream is already open by then, so the failure
    // takes the contract's post-stream shape: an `error` event on the 200, never a 502.
    const run = await prepared('a topic with no recorded write fixture at all')
    const quota = new RecordingQuota()
    const channel = new SseChannel()
    const events: SseEvent[] = []
    const drained = (async () => {
      for await (const e of channel.events()) events.push(e)
    })()

    const warn = vi.spyOn(console, 'warn')
    const result = await runGeneration(run, channel, {
      db: family.db,
      sink: new MemoryLogSink(),
      quota,
      now: () => FIXED_NOW,
    })
    await drained

    expect(result.status).toBe('failed')
    const outcomes = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('outcome='))
    warn.mockRestore()
    expect(outcomes).toEqual([expect.stringMatching(/^\[generate\] outcome=failed .* writes=1 reason=/)])
    expect(events.map((e) => e.type)).toEqual(['facts', 'error'])
    const failure = events[1] as Extract<SseEvent, { type: 'error' }>
    expect(failure.code).toBe('generation_failed')
    expect(failure.quota_consumed).toBe(false)

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
          requested_characters: [],
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
          requested_characters: [],
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

  it('VT-C3: a requested character reaches the writer\'s request and sets the notice', async () => {
    const topic = 'Spider-Man teaches Juno to climb walls'
    const topicKey = `vt-c3-how-animals-climb-walls-${randomUUID().slice(0, 8)}`
    // The normalizer keys the real-world subject; the pack is the shared, brand-free one.
    stubFixture(
      'normalize',
      callFixtureKey({
        model: modelForRole('helper'),
        system: [{ text: loadPrompt('normalize').body }],
        messages: [{ role: 'user', content: `${untrustedBlock('topic', topic)}\n\nReturn the normalization JSON.` }],
        maxTokens: 400,
      }),
      JSON.stringify({
        topic_key: topicKey,
        topic_label: 'How animals climb walls',
        is_appropriate_for_children: true,
        reason: 'a nature topic',
      }),
    )
    await insertFactPack(family.db, topicKey, FIXTURE_FACT_PACK, 'How animals climb walls')
    try {
      const character = {
        decision: 'allow_with_care' as const,
        category: 'commercial_ip_character' as const,
        care_notes: 'Teach how geckos and spiders grip. Spider-Man comes along; the children lead.',
        min_recommended_age: 4,
        requested_characters: ['Spider-Man'],
        topic_key_hint: 'how-animals-climb-walls',
        parent_message: null,
      }
      const result = await prepareGeneration(
        family.familyId,
        { ...base(), topic_input: topic },
        { db: family.db, sink: new MemoryLogSink(), quota: new RecordingQuota(), inputGuard: { check: async () => character } },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.prepared.contentNotice).toBe('borrowed_character')
      expect(result.prepared.request.requested_characters).toEqual(['Spider-Man'])
      expect(result.prepared.request.care_notes).toBe(character.care_notes)
      // The character is not the topic: nothing about it reaches the shared fact pack's key.
      expect(result.prepared.topicKey).toBe(topicKey)
      expect(result.prepared.topicLabel).toBe('How animals climb walls')

      // The same request with an ordinary classification carries neither.
      const plain = await prepareGeneration(
        family.familyId,
        { ...base(), topic_input: topic },
        {
          db: family.db,
          sink: new MemoryLogSink(),
          quota: new RecordingQuota(),
          inputGuard: {
            check: async () => ({ ...character, decision: 'allow' as const, category: 'educational' as const, care_notes: null, requested_characters: [] }),
          },
        },
      )
      expect(plain.ok).toBe(true)
      if (!plain.ok) return
      expect(plain.prepared.contentNotice).toBeNull()
      expect(plain.prepared.request.requested_characters).toEqual([])
    } finally {
      await family.db.from('fact_packs').delete().eq('topic_key', topicKey)
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
