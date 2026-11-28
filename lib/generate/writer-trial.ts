import type { SupabaseClient } from '@supabase/supabase-js'
import { isConfiguredModel, masterPromptIdFor } from '@/lib/ai/pricing'
import { isOwner } from '@/lib/owner'
import { loadPrompt } from '@/lib/prompts'
import type { StoryStatus } from '@/lib/schemas'
import { afterStreaming, firstDraftUntouched } from './after-streaming'
import type { GenerationDeps } from './deps'
import type { RunGenerationResult } from './pipeline'
import { writerThinkingDisplay } from './production-deps'

/**
 * The owner's writer trial (issue #132, the owner's instruction of 2026-11-28).
 *
 * `OWNER_WRITING_MODEL` names a model from `config/models.json`. While it is set, stories
 * asked for by the user named in `OWNER_USER_ID` - and by nobody else - are written by that
 * model, with the master prompt config gives it (`writer_prompts`). Every other family keeps
 * the configured writer. `OWNER_WRITING_MODEL_UNTIL` (a date, `2026-12-31`) ends it by
 * itself: the last day it applies, in UTC.
 *
 * Read from the environment on every request, like the owner and the kill switch, so
 * removing the variable ends the trial without a deploy. A setting that cannot be used fails
 * CLOSED to the normal writer: an unset owner, a model missing from config or the price table,
 * a date that does not parse or does not exist. A typo gives the owner an ordinary story.
 *
 * What it does not cover: a trial model that is configured but stops working at the gateway.
 * Then the owner's stories fail, as any family's would if the writer were down, until the
 * variable is removed. There is no fallback to the normal writer mid-story: a second writer
 * with a different prompt after a failed first is not what the trial measures.
 *
 * Each trial story that is saved is recorded in `story_evals` (`recordTrialStory`), so
 * `pnpm eval:family` can score it with the judge afterwards. The judge itself never runs
 * here: JUDGE_AGENT.md §1 keeps it out of the request path.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The last moment of the trial's last day (UTC), or null when no end is set. Throws on a bad date. */
function trialEnd(raw: string | undefined): Date | null {
  const value = raw?.trim()
  if (!value) return null
  if (!DAY.test(value)) throw new Error(`OWNER_WRITING_MODEL_UNTIL="${value}" is not a date like 2026-12-31`)
  const end = new Date(`${value}T23:59:59.999Z`)
  // 2026-02-30 parses, as 2 March: a day that does not exist must not lengthen the trial.
  if (Number.isNaN(end.getTime()) || end.toISOString().slice(0, 10) !== value) {
    throw new Error(`OWNER_WRITING_MODEL_UNTIL="${value}" is not a real date`)
  }
  return end
}

let warned: string | null = null
function warnOnce(message: string): void {
  if (warned === message) return
  warned = message
  console.warn(`[writer-trial] ${message}: the owner gets the normal writer`)
}

/** The model that writes this user's stories during the trial, or null for the normal writer. */
export function ownerTrialWriter(userId: string | null | undefined, now: Date = new Date()): string | null {
  const model = process.env.OWNER_WRITING_MODEL?.trim()
  if (!model) return null
  if (!isOwner(userId)) return null
  if (!isConfiguredModel(model)) {
    warnOnce(`OWNER_WRITING_MODEL="${model}" has no capabilities or no price in config`)
    return null
  }
  try {
    const end = trialEnd(process.env.OWNER_WRITING_MODEL_UNTIL)
    if (end && now.getTime() > end.getTime()) return null
  } catch (err) {
    warnOnce((err as Error).message)
    return null
  }
  return model
}

/**
 * The request's deps, with the trial writer for the owner. Anyone else, or no trial: the same
 * object back, untouched. The thinking display is the trial model's own, not the default
 * writer's, so a model that takes none is never sent one.
 */
export function withOwnerTrial(deps: GenerationDeps, userId: string | null | undefined, now: Date = new Date()): GenerationDeps {
  const model = ownerTrialWriter(userId, now)
  if (!model) return deps
  const { thinkingDisplay: _default, ...rest } = deps
  const thinkingDisplay = writerThinkingDisplay(model)
  return { ...rest, writingModel: model, ...(thinkingDisplay ? { thinkingDisplay } : {}) }
}

const SAVED: ReadonlySet<StoryStatus | 'discarded'> = new Set(['ready', 'flagged'])

/**
 * One row in `story_evals` for a saved trial story: who wrote it, with which prompt, the
 * bible it was written to, and what the parent saw happen to it. No score: `pnpm eval:family`
 * adds that. Best-effort - a failure is logged and the story is unaffected (the parent already
 * has it). Returns whether a row was written.
 */
export async function recordTrialStory(
  db: SupabaseClient,
  args: { familyId: string; writingModel: string; result: RunGenerationResult },
): Promise<boolean> {
  const { result } = args
  if (!SAVED.has(result.status) || !result.story || !result.quality) return false
  try {
    const prompt = loadPrompt(masterPromptIdFor(args.writingModel))
    const after = afterStreaming(result.quality, result.firstGated?.story, result.story)
    const { error } = await db.from('story_evals').insert({
      story_id: result.storyId,
      family_id: args.familyId,
      writer_model: args.writingModel,
      master_prompt: `${prompt.id}.v${prompt.version}`,
      bible_before: result.bibleAtStart ?? null,
      write_calls: result.writeCalls,
      after_streaming: after,
      first_draft_untouched: firstDraftUntouched(result.quality, result.writeCalls, after),
    })
    if (error) throw new Error(error.message)
    return true
  } catch (err) {
    console.warn(`[writer-trial] could not record story ${result.storyId} for scoring: ${(err as Error).message}`)
    return false
  }
}
