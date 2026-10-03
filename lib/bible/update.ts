import type { SupabaseClient } from '@supabase/supabase-js'
import { callModel, type GenerationLogSink } from '@/lib/ai'
import { loadPrompt } from '@/lib/prompts'
import { StoryBible, type StoryBibleRecord, type StoryOutput } from '@/lib/schemas'
import { dataBlock } from '@/lib/datablock'
import { serializeBible } from './limits'
import {
  BibleVersionConflict,
  reloadBible,
  writeBible,
  loadBible,
} from './store'
import { deterministicBibleUpdate, mergeBible, withoutCharacters, type BibleUpdateMeta } from './merge'

/**
 * `updateBibleFromStory` (F4). Runs in the background after a story is saved: the parent
 * never waits for it, and it is retried up to 3 times.
 *
 * The helper model gets the OLD bible plus the story that was just written and returns the
 * NEW bible (§4.2). That is one cheap call per story, and it is the only place a story's
 * full text is ever sent to a model after generation - never into a generation prompt
 * (kickoff rule 8).
 */

export const BIBLE_UPDATE_MAX_ATTEMPTS = 3

export interface UpdateBibleOptions {
  db?: SupabaseClient
  sink?: GenerationLogSink
  familyId?: string | null
  storyId?: string | null
  /** Plain-words topic for `topics_covered`. Defaults to the story title. */
  topic?: string
  tones?: readonly string[]
  /** ISO date for `topics_covered` / LRU. Defaults to today (UTC). */
  date?: string
  maxAttempts?: number
  signal?: AbortSignal
  /** Characters borrowed for this one story (issue #27): kept out of the series memory. */
  excludeCharacters?: readonly string[]
}

export interface UpdateBibleResult {
  record: StoryBibleRecord
  /** Model attempts made (1-3). Separate from write attempts - see the retry policy. */
  attempts: number
  /** True when the helper model never produced a valid bible and the fallback was used. */
  usedFallback: boolean
  /** Optimistic-concurrency conflicts hit while writing. Each one costs a re-read, not a call. */
  conflicts: number
  /** True when every write attempt lost its race. The bible is unchanged. */
  abandoned?: boolean
  errors: string[]
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Everything the bible-update call needs, wrapped in data delimiters (GUARDRAILS §3.4). */
export function buildBibleUpdateMessage(
  base: StoryBible,
  story: StoryOutput,
  meta: BibleUpdateMeta,
): string {
  return [
    dataBlock('old_bible', serializeBible(base)),
    dataBlock('story', JSON.stringify(story)),
    dataBlock(
      'meta',
      JSON.stringify({
        topic: meta.topic,
        story_id: meta.storyId,
        date: meta.date,
        tones: meta.tones,
      }),
    ),
    'Return the updated Story Bible as JSON.',
  ].join('\n\n')
}

/**
 * Ask the helper model for the new bible. Returns null when the call fails or the output
 * does not validate - the caller decides whether to retry or fall back.
 */
async function proposeBible(
  base: StoryBible,
  story: StoryOutput,
  meta: BibleUpdateMeta,
  opts: UpdateBibleOptions,
): Promise<{ bible: StoryBible | null; error: string | null }> {
  const prompt = loadPrompt('bible-update')
  try {
    const result = await callModel({
      purpose: 'bible_update',
      role: 'helper',
      system: [{ text: prompt.body }],
      messages: [{ role: 'user', content: buildBibleUpdateMessage(base, story, meta) }],
      maxTokens: 4_000,
      schema: StoryBible,
      familyId: opts.familyId ?? null,
      storyId: opts.storyId ?? null,
      ...(opts.sink ? { sink: opts.sink } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (!result.data) {
      return { bible: null, error: 'bible_update output did not validate against StoryBible' }
    }
    return { bible: result.data, error: null }
  } catch (err) {
    return { bible: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Update the bible for a series from the story just written.
 *
 * Retry policy, in two INDEPENDENT phases. They must not share a budget: with one shared
 * counter, a version conflict on the final attempt silently drops the whole update, which is
 * precisely the failure F4's concurrency VT exists to catch.
 *
 *  1. **Proposal** - up to `maxAttempts` (3) helper-model attempts. If all of them fail,
 *     fall back to `deterministicBibleUpdate`, so continuity never depends on the helper
 *     model being alive.
 *  2. **Write** - up to `maxAttempts` optimistic-concurrency attempts with the SAME
 *     proposal. A conflict costs a re-read and a re-merge, never another model call, so a
 *     concurrent update is cheap and neither writer's content is lost.
 */
export async function updateBibleFromStory(
  seriesId: string,
  story: StoryOutput,
  opts: UpdateBibleOptions = {},
): Promise<UpdateBibleResult> {
  const maxAttempts = opts.maxAttempts ?? BIBLE_UPDATE_MAX_ATTEMPTS
  const date = opts.date ?? today()
  const meta: BibleUpdateMeta = {
    topic: opts.topic ?? story.title,
    storyId: opts.storyId ?? null,
    date,
    tones: opts.tones ?? [],
  }

  const errors: string[] = []
  let conflicts = 0
  let usedFallback = false

  const db = opts.db
  let record = await loadBible(seriesId, db ? { db } : {})

  // ---- phase 1: the proposal ----
  let proposal: StoryBible | null = null
  let attempts = 0
  for (; attempts < maxAttempts && !proposal; ) {
    attempts += 1
    const { bible, error } = await proposeBible(record.content, story, meta, opts)
    if (error) errors.push(`model attempt ${attempts}: ${error}`)
    proposal = bible
  }
  if (!proposal) {
    proposal = deterministicBibleUpdate(record.content, story, meta)
    usedFallback = true
  }
  proposal = withoutCharacters(proposal, opts.excludeCharacters ?? [])

  // ---- phase 2: the write ----
  for (let writeAttempt = 1; writeAttempt <= maxAttempts; writeAttempt += 1) {
    const merged = mergeBible(record.content, proposal, date)
    try {
      const written = db
        ? await writeBible(record, merged, db)
        : await writeBible(record, merged)
      return { record: written, attempts, usedFallback, conflicts, errors }
    } catch (err) {
      if (!(err instanceof BibleVersionConflict)) throw err
      conflicts += 1
      errors.push(`write attempt ${writeAttempt}: version conflict`)
      record = db ? await reloadBible(seriesId, db) : await reloadBible(seriesId)
    }
  }

  // Every write lost its race. Report it rather than claim success: the caller logs it and
  // the next story's update will carry this story's topic forward anyway.
  errors.push(`gave up after ${maxAttempts} write attempts`)
  return { record, attempts, usedFallback, conflicts, abandoned: true, errors }
}

/**
 * Fire-and-forget wrapper used by the generation pipeline. The parent's response is not
 * held up by the bible update (F4 AC), and a failure is logged rather than thrown.
 */
export function scheduleBibleUpdate(
  seriesId: string,
  story: StoryOutput,
  opts: UpdateBibleOptions = {},
): Promise<UpdateBibleResult | null> {
  return updateBibleFromStory(seriesId, story, opts).catch((err: unknown) => {
    console.error(
      `[bible] update failed for series ${seriesId}:`,
      err instanceof Error ? err.message : err,
    )
    return null
  })
}

export { reloadBible, BibleVersionConflict }
