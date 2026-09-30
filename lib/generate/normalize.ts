import {
  STORY_MAX_TRUE_FACTS,
  STORY_MIN_TRUE_FACTS,
  countWords,
  type FactPack,
  type StoryOutput,
} from '@/lib/schemas'
import { factTermsMissingFromStory } from '@/lib/quality/facts-in-story'

/**
 * Free, local fixes to the writer's output - so a slip in the story's METADATA does not cost
 * a model call, or the whole story.
 *
 * What it replaces. Every one of the owner's first real stories failed schema validation
 * and went to a Haiku "repair" call ($0.025 and 39 s each); one repair failed too, and a
 * finished, streamed story was thrown away. The master prompt had never stated the schema's
 * length limits, so the writer could not have known them (fixed in master.v2), and the API
 * can now enforce the shape itself (structured outputs, output-schema.ts). What is left is
 * what a JSON schema cannot express - lengths and counts - and that is handled here.
 *
 * THE RULE: story prose is never changed. `chapters[].text` and `ending_line` pass through
 * byte for byte. Only labels, bookkeeping and the True Facts list are touched, and every
 * change is reported in `notes`, which the pipeline saves with the story.
 */

export interface Normalized<T> {
  value: T
  notes: string[]
}

const RECURRING_TYPES = new Set(['device', 'character', 'place', 'object'])
const FACT_ID = /^f\d+$/

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Cut at a word boundary, so a label never ends mid-word. */
function clip(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—-]+$/, '')}…`
}

/** Shape-level fixes, before schema validation. Accepts anything; returns it untouched if odd. */
export function normalizeStoryCandidate(raw: unknown): Normalized<unknown> {
  if (!isRecord(raw)) return { value: raw, notes: [] }
  const notes: string[] = []
  const story: Record<string, unknown> = { ...raw }

  if (typeof story.subtitle === 'string') {
    const t = story.subtitle.trim()
    if (t === '' || t.length > 200) {
      if (t !== '') notes.push('subtitle over 200 characters: removed')
      story.subtitle = null
    }
  } else if (story.subtitle === undefined) {
    story.subtitle = null
  }

  if (Array.isArray(story.chapters)) {
    story.chapters = story.chapters.map((ch, i) => {
      if (!isRecord(ch)) return ch
      const out = { ...ch }
      if (typeof out.heading === 'string' && out.heading.trim().length > 160) {
        out.heading = clip(out.heading, 160)
        notes.push(`chapter ${i + 1}: heading shortened to 160 characters`)
      }
      if (typeof out.shout_line === 'string') {
        const t = out.shout_line.trim()
        if (t === '' || t.length > 80) {
          if (t !== '') notes.push(`chapter ${i + 1}: shout_line over 80 characters: removed`)
          out.shout_line = null
        }
      } else if (out.shout_line === undefined) {
        out.shout_line = null
      }
      return out
    })
  }

  if (Array.isArray(story.true_facts)) {
    const kept = story.true_facts.filter((item, i) => {
      const ok =
        isRecord(item) &&
        typeof item.text === 'string' &&
        item.text.trim() !== '' &&
        item.text.trim().length <= 400 &&
        typeof item.fact_id === 'string' &&
        FACT_ID.test(item.fact_id)
      if (!ok) notes.push(`true_facts[${i}]: malformed or over 400 characters: removed`)
      return ok
    })
    if (kept.length > STORY_MAX_TRUE_FACTS) {
      notes.push(`true_facts: kept the first ${STORY_MAX_TRUE_FACTS} of ${kept.length}`)
    }
    story.true_facts = kept.slice(0, STORY_MAX_TRUE_FACTS)
  }

  const suggestions = isRecord(story.bible_suggestions) ? { ...story.bible_suggestions } : {}
  if (!isRecord(story.bible_suggestions)) notes.push('bible_suggestions missing: set to empty')
  const recurring = Array.isArray(suggestions.new_recurring) ? suggestions.new_recurring : []
  const usable = recurring
    .filter(
      (r): r is Record<string, unknown> =>
        isRecord(r) &&
        typeof r.name === 'string' &&
        r.name.trim() !== '' &&
        typeof r.rule === 'string' &&
        r.rule.trim() !== '' &&
        typeof r.type === 'string' &&
        RECURRING_TYPES.has(r.type),
    )
    .map((r) => ({ name: clip(r.name as string, 80), type: r.type, rule: clip(r.rule as string, 240) }))
  if (usable.length !== recurring.length) {
    notes.push(`new_recurring: ${recurring.length - usable.length} unusable entr(ies) removed`)
  }
  if (usable.length > 2) notes.push(`new_recurring: kept the first 2 of ${usable.length}`)
  suggestions.new_recurring = usable.slice(0, 2)
  suggestions.ending_summary =
    typeof suggestions.ending_summary === 'string' ? clip(suggestions.ending_summary, 400) : ''
  story.bible_suggestions = suggestions

  const minutes = story.estimated_read_minutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0 || minutes > 60) {
    const words = Array.isArray(story.chapters)
      ? story.chapters.reduce(
          (n: number, ch) => n + (isRecord(ch) && typeof ch.text === 'string' ? countWords(ch.text) : 0),
          0,
        )
      : 0
    // ~140 words a minute read aloud at bedtime pace.
    story.estimated_read_minutes = Math.min(60, Math.max(1, Math.round(words / 140)))
    notes.push('estimated_read_minutes missing or out of range: computed from the word count')
  }

  return { value: story, notes }
}

/**
 * Remove True Facts items that cannot stand: a `fact_id` that is not in the pack (the master
 * prompt's own instruction is "if you cannot attribute an item to a pack fact, cut the
 * item"), or a bold term the story never used. All or nothing: if removing them would leave
 * fewer than the minimum, nothing is removed and the gate fails the story with the exact
 * reason, because then the list needs a writer, not a filter.
 */
export function salvageTrueFacts(
  story: StoryOutput,
  pack: FactPack | null,
): Normalized<StoryOutput> {
  const drop = new Map<number, string>()
  if (pack) {
    const known = new Set(pack.facts.map((f) => f.id))
    for (const [i, item] of story.true_facts.entries()) {
      if (!known.has(item.fact_id)) drop.set(i, `${item.fact_id} is not in the fact pack`)
    }
  }
  for (const miss of factTermsMissingFromStory(story)) {
    if (!drop.has(miss.index)) {
      drop.set(miss.index, `${miss.fact_id} names "${miss.term}", which the story never used`)
    }
  }
  if (drop.size === 0 || story.true_facts.length - drop.size < STORY_MIN_TRUE_FACTS) {
    return { value: story, notes: [] }
  }
  return {
    value: { ...story, true_facts: story.true_facts.filter((_, i) => !drop.has(i)) },
    notes: [...drop.values()].map((why) => `true_facts: removed an item - ${why}`),
  }
}
