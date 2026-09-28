import {
  BIBLE_MAX_RECURRING,
  type RecurringElement,
  type StoryBible,
  type StoryOutput,
  type TopicCovered,
} from '@/lib/schemas'
import { enforceBibleLimits } from './limits'

/**
 * Deterministic bible arithmetic. Two jobs:
 *
 *  1. `mergeBible` resolves an optimistic-concurrency conflict without a second model
 *     call: the model output we already have is re-applied onto the base someone else
 *     wrote. F4 VT: "the other retries and succeeds with merged content."
 *  2. `deterministicBibleUpdate` is the fallback when the helper model fails three times.
 *     Losing `last_story.ending` would break the next story's cold open, so continuity is
 *     never allowed to depend on a model call succeeding.
 */

export interface BibleUpdateMeta {
  /** Plain-words topic for `topics_covered`, e.g. "history of LEGO". */
  topic: string
  storyId: string | null
  /** ISO date (YYYY-MM-DD). */
  date: string
  tones: readonly string[]
}

function dedupeStrings(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const item of list) {
      const key = item.trim().toLowerCase()
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      out.push(item.trim())
    }
  }
  return out
}

function mergeRecurring(
  base: readonly RecurringElement[],
  incoming: readonly RecurringElement[],
  today: string,
): RecurringElement[] {
  const byName = new Map<string, RecurringElement>()
  for (const r of base) byName.set(r.name.toLowerCase(), { ...r })
  for (const r of incoming) {
    const key = r.name.toLowerCase()
    const prev = byName.get(key)
    byName.set(key, {
      ...r,
      // Anything the incoming update mentions counts as used tonight, which is what makes
      // the LRU trim meaningful.
      last_used: today,
      ...(prev && !r.rule ? { rule: prev.rule } : {}),
    })
  }
  return [...byName.values()]
}

function mergeTopics(
  base: readonly TopicCovered[],
  incoming: readonly TopicCovered[],
): TopicCovered[] {
  const seen = new Set<string>()
  const out: TopicCovered[] = []
  for (const t of [...base, ...incoming]) {
    const key = `${t.topic.trim().toLowerCase()}|${t.date}|${t.story_id ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...t })
  }
  return out
}

/**
 * Apply `proposed` onto `base`. `base` is whatever is in the database now; `proposed` is
 * what the update produced. Additive fields union; single-valued fields take the proposal.
 */
export function mergeBible(
  base: StoryBible,
  proposed: StoryBible,
  today: string,
): StoryBible {
  return enforceBibleLimits({
    // The proposal's children come from the base it was built on, so prefer the newest
    // profile data but keep any role_notes the proposal learned tonight.
    children: base.children.map((c) => {
      const fromProposal = proposed.children.find((p) => p.name === c.name)
      return { ...c, role_notes: fromProposal?.role_notes ?? c.role_notes ?? null }
    }),
    recurring: mergeRecurring(base.recurring, proposed.recurring, today),
    catchphrases: dedupeStrings(base.catchphrases, proposed.catchphrases),
    topics_covered: mergeTopics(base.topics_covered, proposed.topics_covered),
    last_story: proposed.last_story ?? base.last_story,
    tone_history: dedupeStrings(base.tone_history, proposed.tone_history),
    avoid: dedupeStrings(proposed.avoid, base.avoid).slice(0, 10),
  })
}

/**
 * The update we can make without a model: record the topic, the ending and the tones, and
 * promote whatever the writer itself suggested in `bible_suggestions`.
 */
export function deterministicBibleUpdate(
  base: StoryBible,
  story: StoryOutput,
  meta: BibleUpdateMeta,
): StoryBible {
  const suggested: RecurringElement[] = story.bible_suggestions.new_recurring.map((r) => ({
    ...r,
    last_used: meta.date,
  }))

  return enforceBibleLimits({
    children: base.children.map((c) => ({ ...c })),
    recurring: mergeRecurring(base.recurring, suggested, meta.date).slice(
      -BIBLE_MAX_RECURRING * 2,
    ),
    catchphrases: dedupeStrings(
      base.catchphrases,
      story.chapters.map((c) => c.shout_line ?? '').filter((s) => s !== ''),
    ),
    topics_covered: mergeTopics(base.topics_covered, [
      { topic: meta.topic, story_id: meta.storyId, date: meta.date },
    ]),
    last_story: {
      title: story.title,
      ending: story.bible_suggestions.ending_summary || story.ending_line,
    },
    tone_history: dedupeStrings(base.tone_history, meta.tones),
    avoid: base.avoid,
  })
}
