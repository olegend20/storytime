import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { callModel, streamModel, ModelRefusalError } from '@/lib/ai'
import { serverEnv } from '@/lib/env'
import { parentMessage, type ParentMessageKey } from '@/lib/messages'
import {
  GenerateStoryBody,
  HTTP_STATUS_FOR_ERROR,
  type ErrorBody,
  type FactPack,
  type GenerationRequest,
  type FactPackRecord,
  type QualityResult,
  type SseEvent,
  type StoryOutput,
  type StoryStatus,
  storyWordCount,
  targetWords,
  type AgeBand,
} from '@/lib/schemas'
import {
  bandForChildren,
  getOrCreateSeries,
  loadBible,
  loadChildProfiles,
  scheduleBibleUpdate,
  UnknownChildrenError,
  type ChildProfile,
} from '@/lib/bible'
import {
  FactPackRejectedError,
  getOrBuildFactPack,
  normalizeTopic,
  TopicNormalizationError,
} from '@/lib/topics'
import { runQualityGate } from '@/lib/quality'
import { buildPrompt } from './prompt'
import { parseStoryOutput } from './parse'
import { StoryStreamParser } from './story-stream'
import { SseChannel } from './sse'
import { resolveGuard, resolveQuota, type GenerationDeps, type QuotaState } from './deps'

/**
 * F6 - the story generation pipeline.
 *
 * Split in two on purpose, because the HTTP contract is split in two
 * (`lib/schemas/api.ts`): everything that can fail BEFORE a byte is written happens in
 * `prepareGeneration` and returns a JSON body with a real status code; everything after the
 * stream opens happens in `runGeneration` and reports failure as an `error` event on a 200.
 *
 * Exactly one writing-model call on the happy path, two at most when the gate asks for a
 * rewrite (F6 AC).
 */

export type GenerationErrorCode = Extract<SseEvent, { type: 'error' }>['code']

export interface PreStreamFailure {
  error: ErrorBody & { code: GenerationErrorCode }
  status: number
}

function failure(
  code: GenerationErrorCode,
  messageKey: ParentMessageKey,
  extra: { message?: string; resets_at?: string | null } = {},
): PreStreamFailure {
  return {
    error: {
      code,
      message: extra.message ?? parentMessage(messageKey),
      quota_consumed: false,
      resets_at: extra.resets_at ?? null,
    },
    status: HTTP_STATUS_FOR_ERROR[code] ?? 500,
  }
}

export interface PreparedGeneration {
  familyId: string
  storyId: string
  seriesId: string
  children: ChildProfile[]
  band: AgeBand
  request: GenerationRequest
  factPack: FactPackRecord | null
  topicInput: string
  topicKey: string
  topicLabel: string
  quota: QuotaState
  bibleVersion: number
}

export type PrepareResult =
  | { ok: true; prepared: PreparedGeneration }
  | ({ ok: false } & PreStreamFailure)

/**
 * Everything up to (but not including) the writing-model call. Ordered cheapest-first
 * (GUARDRAILS.md §1.2): free checks, then the quota, then Haiku, then the fact pack.
 */
export async function prepareGeneration(
  familyId: string,
  rawBody: unknown,
  deps: GenerationDeps = {},
): Promise<PrepareResult> {
  const db = deps.db ?? supabaseService()
  const sink = deps.sink
  const parsedBody = GenerateStoryBody.safeParse(rawBody)
  if (!parsedBody.success) {
    return { ok: false, ...failure('invalid_request', 'invalid_request') }
  }
  const body = parsedBody.data

  // ---- 1. kill switch (free) ----
  if (!serverEnv().GENERATION_ENABLED) {
    return { ok: false, ...failure('service_paused', 'service_paused') }
  }

  // ---- 2. quota preflight (lane 3), BEFORE the first model call. Consumes nothing. ----
  const quotaService = resolveQuota(deps)
  const quota = await quotaService.preflight(familyId)
  if (!quota.generation_enabled) {
    const code: GenerationErrorCode = quota.disabled_reason ?? 'service_paused'
    return { ok: false, ...failure(code, code) }
  }
  if (!quota.allowed) {
    return {
      ok: false,
      ...failure('quota_exceeded', 'quota_exceeded', { resets_at: quota.resets_at }),
    }
  }

  // ---- 3. children ----
  let children: ChildProfile[]
  try {
    children = await loadChildProfiles(familyId, body.child_ids, db)
  } catch (err) {
    if (err instanceof UnknownChildrenError) {
      return { ok: false, ...failure('invalid_request', 'invalid_request') }
    }
    throw err
  }
  const band = bandForChildren(children)
  const youngestAge = Math.min(...children.map((c) => c.age))

  // ---- 4. input guardrails (lane 6: L1 + L2) ----
  const guard = await resolveGuard(deps).check({
    topicInput: body.topic_input,
    children,
    youngestAge,
    familyId,
    ...(sink ? { sink } : {}),
  })
  if (guard.decision === 'refuse') {
    const code: GenerationErrorCode =
      guard.category === 'too_mature_for_band' ? 'too_mature_for_band' : 'topic_refused'
    const messageKey: ParentMessageKey =
      guard.category === 'too_mature_for_band'
        ? 'too_mature_for_band'
        : guard.category === 'off_mission'
          ? 'off_mission'
          : 'topic_refused'
    return {
      ok: false,
      ...failure(code, messageKey, guard.parent_message ? { message: guard.parent_message } : {}),
    }
  }

  // ---- 5. normalize the topic (Haiku, ~$0.0003) ----
  let topicKey: string
  let topicLabel: string
  try {
    const normalized = await normalizeTopic(body.topic_input, {
      familyId,
      ...(sink ? { sink } : {}),
    })
    if (!normalized.is_appropriate_for_children) {
      return { ok: false, ...failure('topic_refused', 'topic_refused') }
    }
    // The L2 classifier's `topic_key_hint` is advisory: the normalizer is the single
    // authority on the key, because the key decides which shared fact pack is reused and two
    // sources of truth for it would fragment the library.
    topicKey = normalized.topic_key
    topicLabel = normalized.topic_label
  } catch (err) {
    // Every failure of this step is a friendly 502 with the quota untouched (F6 AC), not
    // just an unparseable response: a Haiku outage, a rate limit or a refusal must not reach
    // the parent as a 500. Logged so it stays visible rather than swallowed.
    if (!(err instanceof TopicNormalizationError)) {
      console.error('[generate] topic normalization failed:', err)
    }
    return { ok: false, ...failure('generation_failed', 'generation_failed') }
  }

  // ---- 6. fact pack: one build per topic, ever (§1 principle 2) ----
  let factPack: FactPackRecord | null = null
  try {
    const pack = await getOrBuildFactPack(topicKey, topicLabel, {
      db,
      ...(sink ? { sink } : {}),
      ...(deps.factPackBuilder ? { builder: deps.factPackBuilder } : {}),
      ...(deps.factPackReviewer ? { reviewer: deps.factPackReviewer } : {}),
    })
    factPack = pack.record
  } catch (err) {
    // Same reasoning as normalization: a rejected pack, a failed build, a search outage and a
    // lock timeout are all "we could not make a story tonight", free to the parent.
    if (!(err instanceof FactPackRejectedError)) {
      console.error('[generate] fact pack unavailable:', err)
    }
    return { ok: false, ...failure('generation_failed', 'generation_failed') }
  }

  // ---- 7. series and bible ----
  const series = await getOrCreateSeries(familyId, body.child_ids, db)
  const bible = await loadBible(series.id, { db, children, childIds: body.child_ids })

  const target = targetWords({ band, minutes: body.length_minutes })
  const request: GenerationRequest = {
    children: children.map((c) => ({
      name: c.first_name,
      age: c.age,
      likes: c.likes ?? [],
      notes: c.notes ?? null,
    })),
    age_band: band,
    tones: body.tones,
    length_minutes: body.length_minutes,
    target_words: target,
    topic_label: topicLabel,
    topic_key: topicKey,
    avoid: bible.content.avoid,
    care_notes: guard.decision === 'allow_with_care' ? guard.care_notes : null,
    rewrite_reasons: [],
  }

  return {
    ok: true,
    prepared: {
      familyId,
      storyId: randomUUID(),
      seriesId: series.id,
      children,
      band,
      request,
      factPack,
      topicInput: body.topic_input,
      topicKey,
      topicLabel,
      quota,
      bibleVersion: bible.version,
    },
  }
}

export interface RunGenerationResult {
  storyId: string
  status: StoryStatus | 'discarded'
  story: StoryOutput | null
  quality: QualityResult | null
  wordCount: number
  writeCalls: number
  /** Resolves when the background bible update finishes. Null when no story was saved. */
  bibleUpdate: Promise<unknown> | null
}

/**
 * The streamed half. Emits `meta` as soon as the title is known, chapters as they arrive,
 * then runs the gate, saves, consumes quota and emits `done`.
 */
export async function runGeneration(
  prepared: PreparedGeneration,
  channel: SseChannel,
  deps: GenerationDeps = {},
): Promise<RunGenerationResult> {
  const db = deps.db ?? supabaseService()
  const sink = deps.sink
  const pack = prepared.factPack?.content ?? null
  let writeCalls = 0

  const emitMetaAndChapters = (): StoryStreamParser =>
    new StoryStreamParser({
      onMeta: ({ title, subtitle }) =>
        channel.push({
          type: 'meta',
          story_id: prepared.storyId,
          series_id: prepared.seriesId,
          title,
          subtitle,
          age_band: prepared.band,
          target_words: prepared.request.target_words,
          topic_label: prepared.topicLabel,
        }),
      onChapterStart: (index, heading) =>
        channel.push({ type: 'chapter_start', index, heading }),
      onChapterDelta: (index, text) => channel.push({ type: 'chapter_delta', index, text }),
      onChapterEnd: (index, shoutLine) =>
        channel.push({ type: 'chapter_end', index, shout_line: shoutLine }),
    })

  try {
    // ---- attempt 1: the streamed write ----
    const parser = emitMetaAndChapters()
    const prompt = buildPrompt({
      request: prepared.request,
      bible: (await loadBible(prepared.seriesId, { db })).content,
      factPack: pack,
    })
    writeCalls += 1
    const streamed = await streamModel({
      purpose: 'write',
      role: 'writer',
      ...(deps.writingModel ? { model: deps.writingModel } : {}),
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: 16_000,
      thinking: 'adaptive',
      familyId: prepared.familyId,
      storyId: prepared.storyId,
      ...(sink ? { sink } : {}),
      onText: (delta) => parser.feed(delta),
    })
    parser.end()

    let parsed = await parseStoryOutput(streamed.text, {
      familyId: prepared.familyId,
      storyId: prepared.storyId,
      ...(sink ? { sink } : {}),
    })
    if (!parsed.ok) {
      // Field paths and rule messages only - never story text. Without them a
      // `repair_failed:schema_invalid` in the owner's first real session was undiagnosable:
      // it could equally have been a count, a length cap or a truncated response.
      throw new GenerationFailed(
        `story output unusable: ${parsed.reason}; stop_reason=${streamed.stopReason ?? 'unknown'}; ` +
          `output_tokens=${streamed.usage.output_tokens}; issues: ${parsed.issues.slice(0, 8).join(' | ')}`,
      )
    }
    let story = parsed.story

    // ---- the gate ----
    let gate = await runQualityGate({
      story,
      request: prepared.request,
      factPack: pack,
      attempt: 1,
      familyId: prepared.familyId,
      storyId: prepared.storyId,
      ...(sink ? { sink } : {}),
      ...(deps.safetyReviewer ? { safetyReviewer: deps.safetyReviewer } : {}),
      ...(deps.extraBlocklists ? { extraBlocklists: deps.extraBlocklists } : {}),
    })

    // ---- at most one rewrite (F6 AC: two writing-model calls maximum) ----
    if (gate.needsRewrite) {
      const rewriteRequest: GenerationRequest = {
        ...prepared.request,
        rewrite_reasons: gate.result.rewrite_reasons,
      }
      const rewritePrompt = buildPrompt({
        request: rewriteRequest,
        bible: (await loadBible(prepared.seriesId, { db })).content,
        factPack: pack,
      })
      writeCalls += 1
      // Not streamed: the client has already received attempt 1's chapters, and replaying
      // the same indices would corrupt its concatenation. The rewrite arrives in `done`.
      const rewritten = await callModel({
        purpose: 'rewrite',
        role: 'writer',
        ...(deps.writingModel ? { model: deps.writingModel } : {}),
        system: rewritePrompt.system,
        messages: rewritePrompt.messages,
        maxTokens: 16_000,
        thinking: 'adaptive',
        familyId: prepared.familyId,
        storyId: prepared.storyId,
        ...(sink ? { sink } : {}),
      })
      parsed = await parseStoryOutput(rewritten.text, {
        familyId: prepared.familyId,
        storyId: prepared.storyId,
        ...(sink ? { sink } : {}),
      })
      if (parsed.ok) {
        story = parsed.story
        gate = await runQualityGate({
          story,
          request: rewriteRequest,
          factPack: pack,
          attempt: 2,
          familyId: prepared.familyId,
          storyId: prepared.storyId,
          ...(sink ? { sink } : {}),
          ...(deps.safetyReviewer ? { safetyReviewer: deps.safetyReviewer } : {}),
          ...(deps.extraBlocklists ? { extraBlocklists: deps.extraBlocklists } : {}),
        })
      } else {
        // Keep attempt 1's story and flag it rather than show the parent nothing.
        gate = {
          ...gate,
          result: {
            ...gate.result,
            outcome: 'flagged',
            attempt: 2,
            rewrite_reasons: [
              ...gate.result.rewrite_reasons,
              `rewrite output unusable: ${parsed.reason}`,
            ],
          },
          status: 'flagged',
          needsRewrite: false,
        }
      }
    }

    // GUARDRAILS.md §4.1: a second HARD safety breach is discarded, quota untouched.
    if (gate.result.outcome === 'discarded') {
      channel.push({
        type: 'error',
        code: 'generation_failed',
        message: parentMessage('generation_failed'),
        quota_consumed: false,
        resets_at: null,
      })
      return {
        storyId: prepared.storyId,
        status: 'discarded',
        story,
        quality: gate.result,
        wordCount: gate.result.word_count,
        writeCalls,
        bibleUpdate: null,
      }
    }

    // ---- save ----
    const wordCount = storyWordCount(story)
    const status: StoryStatus = gate.status === 'ready' ? 'ready' : 'flagged'
    const { error: insertError } = await db.from('stories').insert({
      id: prepared.storyId,
      family_id: prepared.familyId,
      series_id: prepared.seriesId,
      topic_input: prepared.topicInput,
      topic_key: prepared.topicKey,
      fact_pack_id: prepared.factPack?.id ?? null,
      tones: prepared.request.tones,
      length_minutes: prepared.request.length_minutes,
      age_band: prepared.band,
      title: story.title,
      content: story,
      word_count: wordCount,
      quality: gate.result,
      status,
    })
    if (insertError) throw new GenerationFailed(`saving the story failed: ${insertError.message}`)

    // F8 AC: quota is consumed ONLY after a successful stories insert. This line and the
    // `preflight` in prepareGeneration are the whole enforcement - lane 3 cannot check it.
    const quotaAfter = await resolveQuota(deps).consumeQuota(prepared.familyId)

    channel.push({
      type: 'done',
      story_id: prepared.storyId,
      story,
      quality: gate.result,
      word_count: wordCount,
      quota: { used: quotaAfter.used, limit: quotaAfter.limit },
    })

    // Background bible update (F4 AC), started after `done` so the parent never waits on it.
    const bibleUpdate = scheduleBibleUpdate(prepared.seriesId, story, {
      db,
      ...(sink ? { sink } : {}),
      familyId: prepared.familyId,
      storyId: prepared.storyId,
      topic: prepared.topicLabel,
      tones: prepared.request.tones,
      // `deps.now` exists so a test can pin this date: it goes into the bible-update prompt,
      // and a prompt that changes at midnight cannot be replayed from a fixture.
      date: (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
    })

    return {
      storyId: prepared.storyId,
      status,
      story,
      quality: gate.result,
      wordCount,
      writeCalls,
      bibleUpdate,
    }
  } catch (err) {
    const message = parentMessage('generation_failed')
    const body: ErrorBody & { code: GenerationErrorCode } = {
      code: 'generation_failed',
      message,
      quota_consumed: false,
      resets_at: null,
    }
    if (channel.isOpen) {
      // Post-stream: the contract says an `error` event on the already-committed 200.
      channel.push({ type: 'error', ...body })
    } else {
      // Nothing sent yet: the route can still answer 502 with a JSON body.
      channel.fail({ error: body, status: HTTP_STATUS_FOR_ERROR.generation_failed ?? 502 })
    }
    if (err instanceof ModelRefusalError || err instanceof GenerationFailed) {
      console.error(`[generate] ${err.message}`)
    } else {
      console.error('[generate] unexpected failure:', err)
    }
    return {
      storyId: prepared.storyId,
      status: 'failed',
      story: null,
      quality: null,
      wordCount: 0,
      writeCalls,
      bibleUpdate: null,
    }
  } finally {
    channel.close()
  }
}

export class GenerationFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerationFailed'
  }
}

/** The fact-pack content the gate and the prompt share, for tests and eval. */
export function packContent(record: FactPackRecord | null): FactPack | null {
  return record?.content ?? null
}

export type { SupabaseClient }
