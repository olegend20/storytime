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
import { deterministicBibleUpdate, mergeBible, type BibleUpdateMeta } from './merge'

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
}

export interface UpdateBibleResult {
  record: StoryBibleRecord
  attempts: number
  /** True when the helper model never produced a valid bible and the fallback was used. */
  usedFallback: boolean
  conflicts: number
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
 * Retry policy: up to `maxAttempts` (3) attempts. A model failure retries the model. A
 * version conflict does NOT re-call the model - the proposal we already have is merged
 * onto the freshly-read base, so a concurrent update costs nothing extra and neither
 * writer loses its content.
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
  let proposal: StoryBible | null = null
  let usedFallback = false

  const db = opts.db
  let record = await loadBible(seriesId, db ? { db } : {})

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!proposal) {
      const { bible, error } = await proposeBible(record.content, story, meta, opts)
      if (error) errors.push(`attempt ${attempt}: ${error}`)
      proposal = bible
    }

    // The model has used its attempts: keep continuity rather than lose the ending.
    if (!proposal && attempt === maxAttempts) {
      proposal = deterministicBibleUpdate(record.content, story, meta)
      usedFallback = true
    }
    if (!proposal) continue

    const merged = mergeBible(record.content, proposal, date)
    try {
      const written = db
        ? await writeBible(record, merged, db)
        : await writeBible(record, merged)
      return { record: written, attempts: attempt, usedFallback, conflicts, errors }
    } catch (err) {
      if (err instanceof BibleVersionConflict) {
        // Someone else wrote first. Re-read and merge the SAME proposal onto their content:
        // no second model call, and neither writer's content is lost.
        conflicts += 1
        errors.push(`attempt ${attempt}: version conflict`)
        record = db ? await reloadBible(seriesId, db) : await reloadBible(seriesId)
        continue
      }
      throw err
    }
  }

  return { record, attempts: maxAttempts, usedFallback, conflicts, errors }
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
