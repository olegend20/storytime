import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { callModel, streamModel, structuredOutputRejected, ModelRefusalError } from '@/lib/ai'
import { serverEnv } from '@/lib/env'
import { parentMessage, type ParentMessageKey } from '@/lib/messages'
import {
  GenerateStoryBody,
  HTTP_STATUS_FOR_ERROR,
  type ContentNotice,
  type LengthMinutes,
  MAX_SCARY_LEVEL,
  type ErrorBody,
  type FactPack,
  type GenerationRequest,
  type FactPackRecord,
  type QualityResult,
  type SseEvent,
  type StoryOutput,
  factCardsFor,
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
import { reviewPassed, runQualityGate } from '@/lib/quality'
import { borrowsCharacter, requestedCharacters } from '@/lib/guardrails/classify'
import { cutViolations, mendStory } from './mend'
import { buildPrompt } from './prompt'
import { parseStoryOutput } from './parse'
import { salvageTrueFacts } from './normalize'
import { STORY_OUTPUT_FORMAT } from './output-schema'
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
  /** What the reader must tell the parent about this story, if anything (issue #27). */
  contentNotice: ContentNotice | null
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
    requested_characters: requestedCharacters(guard),
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
      contentNotice: borrowsCharacter(guard) ? 'borrowed_character' : null,
    },
  }
}

/**
 * Attempt 1 failed only on hard-rule breaches - located quotes the mend can act on - and on
 * nothing a full rewrite would be needed for. Decided from the structure of the result, not
 * from the wording of its reasons (CLAUDE.md: reasons are prose, codes are the contract).
 */
export function onlyHardRuleBreaches(result: QualityResult, band: AgeBand): boolean {
  const safety = result.safety
  return (
    result.failures.length === 0 &&
    result.hard_violations.length > 0 &&
    (result.review === null || reviewPassed(result.review, band)) &&
    (safety === null ||
      (safety.scary_level <= MAX_SCARY_LEVEL[band] && safety.positive_portrayal && safety.ending_safe))
  )
}

/** Time the gate, the mend and the save need after a write. */
export const AFTER_WRITE_MS = 45_000
/**
 * Below this, rung 3 does not start: a 5- or 10-minute story takes 60-90 s to write, plus
 * AFTER_WRITE_MS. A truncated first write usually spent most of the request already.
 */
export const RETRY_MIN_MS = 150_000

/** One length tier down; the shortest stays where it is. */
export function shorterLength(minutes: LengthMinutes): LengthMinutes {
  return minutes === 15 ? 10 : 5
}

/**
 * A cap, not a cost: only tokens actually generated are billed. The writer thinks before it
 * writes, and the owner's first 1,400-word story used 13,101 output tokens against the old
 * 16,000 cap - so a 15-minute story for an older child could not have finished at all.
 *
 * Raised again on 2026-10-06 (issue #32, rung 0): a 15-minute band-C story hit 32,000 twice
 * in one day - about 6,500 tokens of story under 25,000 of thinking - and the parent got no
 * book. The story itself is bounded (`WRITER_STORY_TOKENS_MAX`); the thinking is adaptive
 * and is not. The cap leaves the longest story more than 50,000 tokens of thinking.
 */
export const WRITER_MAX_TOKENS = 64_000
/**
 * The most tokens a story's JSON can take: the longest target (15 minutes, band D) at the
 * top of its tolerance (≈ 5,700 words), at ~1.6 tokens a word for prose inside JSON, plus
 * headings, True Facts and the bible suggestions. `WRITER_MAX_TOKENS` must leave room for thinking above
 * this; test/unit/writer-call-shape.test.ts holds the two apart.
 */
export const WRITER_STORY_TOKENS_MAX = 12_000

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
          content_notice: prepared.contentNotice,
        }),
      onChapterStart: (index, heading) =>
        channel.push({ type: 'chapter_start', index, heading }),
      onChapterDelta: (index, text) => channel.push({ type: 'chapter_delta', index, text }),
      onChapterEnd: (index, shoutLine) =>
        channel.push({ type: 'chapter_end', index, shout_line: shoutLine }),
    })

  try {
    // Something for the children while the writer thinks: the facts, before any prose.
    const cards = factCardsFor(pack, Math.min(...prepared.children.map((c) => c.age)))
    if (cards) channel.push(cards)

    // ---- attempt 1: the streamed write ----
    const parser = emitMetaAndChapters()
    const bibleAtStart = (await loadBible(prepared.seriesId, { db })).content
    // The request the saved story was written to: `prepared.request`, unless rung 3 below
    // had to retry it one length tier shorter.
    let request: GenerationRequest = prepared.request
    const prompt = buildPrompt({
      request,
      bible: bibleAtStart,
      factPack: pack,
    })
    writeCalls += 1
    const write = (structured: boolean) =>
      streamModel({
        purpose: 'write',
        role: 'writer',
        ...(deps.writingModel ? { model: deps.writingModel } : {}),
        system: prompt.system,
        messages: prompt.messages,
        maxTokens: WRITER_MAX_TOKENS,
        thinking: 'adaptive',
        ...(structured ? { outputFormat: STORY_OUTPUT_FORMAT } : {}),
        familyId: prepared.familyId,
        storyId: prepared.storyId,
        ...(sink ? { sink } : {}),
        onText: (delta) => parser.feed(delta),
      })
    let structured = true
    const streamed = await write(true).catch((err: unknown) => {
      // A rejected request fails before any text is streamed, so nothing reached the parent.
      if (!structuredOutputRejected(err)) throw err
      console.warn(`[generate] structured outputs rejected, writing without: ${(err as Error).message}`)
      structured = false
      return write(false)
    })
    parser.end()

    let parsed = await parseStoryOutput(streamed.text, {
      familyId: prepared.familyId,
      storyId: prepared.storyId,
      ...(sink ? { sink } : {}),
    })
    // Field paths and rule messages only - never story text. Without them a
    // `repair_failed:schema_invalid` in the owner's first real session was undiagnosable:
    // it could equally have been a count, a length cap or a truncated response.
    const unusable = (p: typeof parsed & { ok: false }, stopReason: string | null | undefined, outputTokens: number) =>
      `story output unusable: ${p.reason}; stop_reason=${stopReason ?? 'unknown'}; ` +
      `output_tokens=${outputTokens}; issues: ${p.issues.slice(0, 8).join(' | ')}`

    // Issue #32, rung 3: an unusable first write (cut off, structurally short, unrepairable)
    // is retried once, one length tier shorter - a shorter story fits every cap and fails
    // far less. Not streamed: the client already holds attempt 1's chapters, so the retry
    // arrives in `done`, as a rewrite does. It is the second and last writing call.
    let retriedShorter: { from: LengthMinutes; to: LengthMinutes; why: string } | null = null
    if (!parsed.ok) {
      const why = unusable(parsed, streamed.stopReason, streamed.usage.output_tokens)
      // Only if there is time to write it, gate it and save it before the request is killed:
      // a retry the platform cuts off sends the parent nothing at all, not even an error.
      const left = deps.deadlineMs === undefined ? Number.POSITIVE_INFINITY : deps.deadlineMs - Date.now()
      if (left < RETRY_MIN_MS) {
        throw new GenerationFailed(`${why}; no shorter retry: ${Math.round(left / 1000)} s left before the request deadline`)
      }
      const to = shorterLength(request.length_minutes)
      console.warn(`[generate] ${why} - retrying at ${to} minutes (was ${request.length_minutes})`)
      retriedShorter = { from: request.length_minutes, to, why }
      request = { ...request, length_minutes: to, target_words: targetWords({ band: prepared.band, minutes: to }) }
      const retryPrompt = buildPrompt({ request, bible: bibleAtStart, factPack: pack })
      writeCalls += 1
      const retry = (withFormat: boolean) =>
        callModel({
          purpose: 'rewrite',
          role: 'writer',
          ...(deps.writingModel ? { model: deps.writingModel } : {}),
          system: retryPrompt.system,
          messages: retryPrompt.messages,
          maxTokens: WRITER_MAX_TOKENS,
          // Bounded by the time left, less what the gate and the save need after it.
          timeoutMs: Math.min(600_000, left - AFTER_WRITE_MS),
          thinking: 'adaptive',
          ...(withFormat ? { outputConfig: { format: STORY_OUTPUT_FORMAT } } : {}),
          familyId: prepared.familyId,
          storyId: prepared.storyId,
          ...(sink ? { sink } : {}),
        })
      const retried = await retry(structured).catch((err: unknown) => {
        if (!structured || !structuredOutputRejected(err)) throw err
        return retry(false)
      })
      parsed = await parseStoryOutput(retried.text, {
        familyId: prepared.familyId,
        storyId: prepared.storyId,
        ...(sink ? { sink } : {}),
      })
      if (!parsed.ok) {
        throw new GenerationFailed(
          `${why}; the shorter retry too: ${unusable(parsed, retried.stopReason, retried.usage.output_tokens)}`,
        )
      }
    }
    // Free local fixes: metadata slips, then True Facts items that cannot stand.
    const tidy = (draft: typeof parsed & { ok: true }) => {
      const facts = salvageTrueFacts(draft.story, pack)
      return { story: facts.value, notes: [...draft.notes, ...facts.notes] }
    }
    let { story, notes: normalized } = tidy(parsed)

    // ---- the gate ----
    let gate = await runQualityGate({
      story,
      request,
      factPack: pack,
      // After a shorter retry there is no writing call left: the gate's verdict is final,
      // and a breach goes down the mend/cut ladder below.
      attempt: retriedShorter ? 2 : 1,
      // A rewrite follows any failure on attempt 1; brief it fully (DECISIONS #138).
      reviewDespiteFailures: true,
      familyId: prepared.familyId,
      storyId: prepared.storyId,
      ...(sink ? { sink } : {}),
      ...(deps.safetyReviewer ? { safetyReviewer: deps.safetyReviewer } : {}),
      ...(deps.extraBlocklists ? { extraBlocklists: deps.extraBlocklists } : {}),
    })

    // Why attempt 1 was sent back. Saved with the story, and logged for the ones never saved.
    const firstAttempt = retriedShorter
      ? {
          failures: [{ check: 'schema_valid' as const, detail: retriedShorter.why.slice(0, 300) }],
          reasons: [`output unusable; retried ${retriedShorter.from} -> ${retriedShorter.to} minutes`],
        }
      : gate.needsRewrite
        ? { failures: gate.result.failures, reasons: gate.result.rewrite_reasons }
        : null
    if (firstAttempt) {
      console.warn(
        `[generate] first draft sent back (${prepared.band}, ${prepared.topicKey}): ` +
          firstAttempt.reasons.join(' | ').slice(0, 1200),
      )
    }

    // Issue #32: the delivery ladder. Rung 1 mends the sentences that broke a hard rule
    // (one helper call, seconds) and re-runs the gate; rung 2 cuts them (free). What is
    // tallied here is saved with the story as `quality.mended`.
    const mended = { edits: 0, cut: 0, rules: new Set<number>() }
    // The whole gate again on text the ladder changed - the safety review included, even
    // when a deterministic check fails, because the mend model wrote that text for a story
    // that had already breached a rule.
    const regate = (attempt: 1 | 2, request: GenerationRequest) =>
      runQualityGate({
        story,
        request,
        factPack: pack,
        attempt,
        reviewDespiteFailures: true,
        familyId: prepared.familyId,
        storyId: prepared.storyId,
        ...(sink ? { sink } : {}),
        ...(deps.safetyReviewer ? { safetyReviewer: deps.safetyReviewer } : {}),
        ...(deps.extraBlocklists ? { extraBlocklists: deps.extraBlocklists } : {}),
      })
    const mend = async (attempt: 1 | 2, request: GenerationRequest): Promise<boolean> => {
      const violations = gate.result.hard_violations
      const result = await mendStory(story, violations, {
        familyId: prepared.familyId,
        storyId: prepared.storyId,
        ...(sink ? { sink } : {}),
      })
      if (result.edits === 0) return false
      for (const v of violations) mended.rules.add(v.rule)
      mended.edits += result.edits
      story = result.story
      gate = await regate(attempt, request)
      return true
    }

    // Rung 1 in place of the full rewrite: when the only thing wrong with attempt 1 is a
    // hard-rule breach, ten seconds of mending beats two minutes of rewriting. Regated as
    // attempt 1, so if the mend did not clear it the full rewrite still follows, briefed
    // with whatever survived.
    if (gate.needsRewrite && onlyHardRuleBreaches(gate.result, prepared.band)) {
      const fixed = await mend(1, request)
      if (fixed && !gate.needsRewrite) {
        console.info(`[generate] mended attempt 1 in place of a rewrite (${[...mended.rules].join(', ')})`)
      }
    }

    // ---- at most one rewrite (F6 AC: two writing-model calls maximum) ----
    if (gate.needsRewrite) {
      const rewriteRequest: GenerationRequest = {
        ...request,
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
      const rewrite = (withFormat: boolean) =>
        callModel({
          purpose: 'rewrite',
          role: 'writer',
          ...(deps.writingModel ? { model: deps.writingModel } : {}),
          system: rewritePrompt.system,
          messages: rewritePrompt.messages,
          maxTokens: WRITER_MAX_TOKENS,
          // Over 300s so callModel streams it: the SDK refuses a non-streaming request this
          // large, and the deadline still bounds the whole call.
          timeoutMs: 600_000,
          thinking: 'adaptive',
          ...(withFormat ? { outputConfig: { format: STORY_OUTPUT_FORMAT } } : {}),
          familyId: prepared.familyId,
          storyId: prepared.storyId,
          ...(sink ? { sink } : {}),
        })
      const rewritten = await rewrite(structured).catch((err: unknown) => {
        if (!structured || !structuredOutputRejected(err)) throw err
        return rewrite(false)
      })
      parsed = await parseStoryOutput(rewritten.text, {
        familyId: prepared.familyId,
        storyId: prepared.storyId,
        ...(sink ? { sink } : {}),
      })
      if (parsed.ok) {
        ;({ story, notes: normalized } = tidy(parsed))
        // The rewrite replaced the text: whatever the in-place mend did is not in it.
        mended.edits = 0
        mended.rules.clear()
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
        // Keep attempt 1's story rather than show the parent nothing. If it still holds a
        // hard-rule breach it goes down the ladder below (mend, cut) like any second breach,
        // instead of shipping flagged with the breach in it.
        const breached = gate.result.hard_violations.length > 0
        gate = {
          ...gate,
          result: {
            ...gate.result,
            outcome: breached ? 'discarded' : 'flagged',
            attempt: 2,
            rewrite_reasons: [
              ...gate.result.rewrite_reasons,
              `rewrite output unusable: ${parsed.reason}`,
            ],
          },
          status: breached ? 'failed' : 'flagged',
          needsRewrite: false,
        }
      }
    }

    // Issue #32: before a discard, mend (rung 1) and then cut (rung 2). A cut counts only
    // when every hard violation was placed and removed, and what it leaves goes through
    // the whole gate again; a breach that survives both is the one discard left.
    if (gate.result.outcome === 'discarded') {
      const ladderRequest: GenerationRequest = { ...request, rewrite_reasons: gate.result.rewrite_reasons }
      await mend(2, ladderRequest)
      if (gate.result.outcome === 'discarded') {
        const violations = gate.result.hard_violations
        const cut = cutViolations(story, violations)
        if (cut.complete) {
          const before = story
          story = cut.story
          gate = await regate(2, ladderRequest)
          if (gate.result.outcome === 'discarded') {
            story = before // nothing shipped from the cut; the record describes the discard
          } else {
            for (const v of violations) mended.rules.add(v.rule)
            mended.cut += cut.cut
            // A story that lost a sentence is shown with the "second look" banner, however
            // clean the gate now finds it.
            if (gate.result.outcome === 'pass') {
              gate = { ...gate, result: { ...gate.result, outcome: 'flagged' }, status: 'flagged' }
            }
          }
        }
      }
    }

    if (firstAttempt) gate.result.first_attempt = firstAttempt
    if (normalized.length > 0) {
      gate.result.normalized = normalized
      console.info(`[generate] fixed locally, no model call: ${normalized.join(' | ')}`)
    }
    // Recorded only for a story that ships: the record describes the text the parent reads.
    if (gate.result.outcome !== 'discarded' && (mended.edits > 0 || mended.cut > 0)) {
      gate.result.mended = { edits: mended.edits, cut: mended.cut, rules: [...mended.rules].sort((a, b) => a - b) }
      console.info(`[generate] mended: ${mended.edits} sentence(s) rewritten, ${mended.cut} cut (rules ${[...mended.rules].join(', ')})`)
    }

    // GUARDRAILS.md §4.1: a breach that survived the mend and the cut is discarded, quota untouched.
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
      // The length actually written: shorter than asked when rung 3 retried it.
      length_minutes: request.length_minutes,
      age_band: prepared.band,
      title: story.title,
      content: story,
      word_count: wordCount,
      quality: gate.result,
      status,
      content_notice: prepared.contentNotice,
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
      excludeCharacters: prepared.request.requested_characters,
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
