import {
  BIBLE_MAX_RECURRING,
  BIBLE_MAX_TOPICS_COVERED,
  BIBLE_TOKEN_LIMIT,
  type RecurringElement,
  type StoryBible,
} from '@/lib/schemas'
import { estimateTokens } from '@/lib/prompts'

/**
 * Size enforcement for the Story Bible (F4). The 800-token cap is the whole reason the
 * architecture works: series memory must not grow with the number of nights, so the bible
 * is trimmed on every write rather than trusted to stay small.
 *
 * Trimming is deterministic and ordered from least to most damaging, so the same bible
 * always reduces the same way.
 */

/** The exact serialization the prompt builder sends, so the estimate matches the wire. */
export function serializeBible(bible: StoryBible): string {
  return JSON.stringify(bible)
}

export function estimateBibleTokens(bible: StoryBible): number {
  return estimateTokens(serializeBible(bible))
}

/** Least-recently-used first. A missing `last_used` sorts oldest. */
function lruOrder(a: RecurringElement, b: RecurringElement): number {
  return (a.last_used ?? '0000-01-01').localeCompare(b.last_used ?? '0000-01-01')
}

/** Most-recently-used `keep` entries, back in their original order. */
function keepMostRecent(recurring: RecurringElement[], keep: number): RecurringElement[] {
  if (recurring.length <= keep) return recurring
  const dropped = new Set(
    [...recurring]
      .sort(lruOrder)
      .slice(0, recurring.length - keep)
      .map((r) => r),
  )
  return recurring.filter((r) => !dropped.has(r))
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * Apply every hard cap, then shrink until the bible fits BIBLE_TOKEN_LIMIT.
 *
 * Hard caps (F4 AC): `topics_covered` keeps the most recent 20, `recurring` keeps at most
 * 8 with least-recently-used dropped first.
 */
export function enforceBibleLimits(
  input: StoryBible,
  limit: number = BIBLE_TOKEN_LIMIT,
): StoryBible {
  const bible: StoryBible = {
    ...input,
    children: input.children.map((c) => ({ ...c })),
    recurring: keepMostRecent(
      input.recurring.map((r) => ({ ...r })),
      BIBLE_MAX_RECURRING,
    ),
    catchphrases: input.catchphrases.slice(0, 10),
    topics_covered: input.topics_covered.slice(-BIBLE_MAX_TOPICS_COVERED).map((t) => ({ ...t })),
    last_story: input.last_story ? { ...input.last_story } : null,
    tone_history: input.tone_history.slice(-20),
    avoid: input.avoid.slice(0, 10),
  }

  // Ordered reductions: each one gives back tokens and costs a little series memory.
  // Cheapest loss first; children are never touched.
  const reductions: (() => boolean)[] = [
    () => shrinkList(bible.avoid, 4),
    () => shrinkFromFront(bible.topics_covered, 10),
    () => shrinkList(bible.tone_history, 6),
    () => shrinkList(bible.catchphrases, 6),
    () => {
      let changed = false
      for (const r of bible.recurring) {
        const next = truncate(r.rule, 120)
        if (next !== r.rule) {
          r.rule = next
          changed = true
        }
      }
      return changed
    },
    () => {
      if (!bible.last_story) return false
      const next = truncate(bible.last_story.ending, 200)
      if (next === bible.last_story.ending) return false
      bible.last_story.ending = next
      return true
    },
    () => {
      let changed = false
      for (const c of bible.children) {
        if (c.role_notes && c.role_notes.length > 60) {
          c.role_notes = truncate(c.role_notes, 60)
          changed = true
        }
      }
      return changed
    },
    () => shrinkFromFront(bible.topics_covered, 3),
    () => {
      if (bible.recurring.length <= 2) return false
      bible.recurring = keepMostRecent(bible.recurring, bible.recurring.length - 1)
      return true
    },
    () => shrinkList(bible.avoid, 0),
    () => shrinkFromFront(bible.topics_covered, 1),
    () => {
      if (bible.recurring.length <= 1) return false
      bible.recurring = keepMostRecent(bible.recurring, 1)
      return true
    },
  ]

  for (const reduce of reductions) {
    if (estimateBibleTokens(bible) <= limit) break
    // Each reduction may need several passes (it shrinks by one step at a time).
    while (estimateBibleTokens(bible) > limit && reduce()) {
      /* keep going */
    }
  }

  return bible
}

function shrinkList(list: unknown[], floor: number): boolean {
  if (list.length <= floor) return false
  list.pop()
  return true
}

function shrinkFromFront(list: unknown[], floor: number): boolean {
  if (list.length <= floor) return false
  list.shift()
  return true
}

/** True when the bible fits the cap. Used by the F4 VT and by the write path. */
export function bibleFitsLimit(bible: StoryBible, limit: number = BIBLE_TOKEN_LIMIT): boolean {
  return estimateBibleTokens(bible) <= limit
}
