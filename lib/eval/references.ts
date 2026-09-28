import {
  asStoryOutput,
  loadManifest,
  loadReferenceStory,
  type ParsedReference,
  type ReferenceEntry,
} from '@/lib/reference'
import { targetWords } from '@/lib/schemas'
import { narrativeWordCount } from './render'
import type { JudgeContext, JudgeableStory } from './types'

/**
 * The four reference stories, in the shape the judge scores.
 *
 * `lib/reference.ts` owns the parsing (kickoff: one parser, not two). This module only
 * adapts what it returns:
 *
 *  1. The cold open used to be folded in here, because `asStoryOutput()` dropped it. The
 *     lead fixed that upstream (DECISIONS.md #54), so folding again would double-count it -
 *     2,102 words instead of 1,851 for the shark story, pushing it out of band. The fold
 *     now happens once, in `lib/reference.ts`.
 *  2. It returns `JudgeableStory`, not `StoryOutput`, as tolerance for judging a story that
 *     fails the strict schema. All four references now validate against `StoryOutput` after
 *     the upstream fix, so this is no longer required for the calibration set itself.
 */

export interface ReferenceCase {
  entry: ReferenceEntry
  parsed: ParsedReference
  story: JudgeableStory
  context: JudgeContext
  wordCount: number
}

/**
 * `asStoryOutput()` already folds the cold open into chapter 1 (DECISIONS.md #18 / #54),
 * so this only widens the type. Do not fold again here.
 */
export function toJudgeable(parsed: ParsedReference): JudgeableStory {
  const out = asStoryOutput(parsed)
  const chapters = out.chapters.map((c) => ({ ...c }))
  return {
    title: out.title,
    subtitle: out.subtitle,
    chapters,
    ending_line: out.ending_line,
    true_facts: out.true_facts,
  }
}

export function contextForEntry(entry: ReferenceEntry): JudgeContext {
  const req = entry.request
  return {
    children: req.children.map((c) => ({
      name: c.name,
      ...(typeof c.age === 'number' ? { age: c.age } : {}),
      ...(c.age_band_note ? { age_note: c.age_band_note } : {}),
      ...(c.likes ? { likes: c.likes } : {}),
      notes: c.notes ?? null,
    })),
    age_band: req.age_band,
    tones: req.tones,
    length_minutes: req.length_minutes,
    target_words: targetWords({ band: req.age_band, minutes: req.length_minutes }),
    topic_label: req.topic_input,
    bible: entry.bible_before,
    // The references predate fact packs. Null here (rather than a fabricated pack) is
    // what makes caps.ts record `factSourcing: 'unverifiable_no_fact_pack'`.
    fact_pack: null,
  }
}

export function loadReferenceCases(): ReferenceCase[] {
  return loadManifest().stories.map((entry) => {
    const parsed = loadReferenceStory(entry.file)
    const story = toJudgeable(parsed)
    return { entry, parsed, story, context: contextForEntry(entry), wordCount: narrativeWordCount(story) }
  })
}

export function referenceCase(cases: ReferenceCase[], file: string): ReferenceCase {
  const found = cases.find((c) => c.entry.file === file)
  if (!found) {
    throw new Error(
      `Reference story "${file}" not found in the manifest. Calibration needs all four ` +
        `(JUDGE_AGENT.md §5); present: ${cases.map((c) => c.entry.file).join(', ')}`,
    )
  }
  return found
}

/** The filenames calibration depends on by name, so a rename fails loudly. */
export const REFERENCE_FILES = {
  lego: 'cruz-and-phoenix-lego-story.md',
  videoGames: 'lennon-and-the-lost-levels.md',
  sharks: 'cruz-and-phoenix-shark-submarine.md',
  soccer: 'lennon-the-beautiful-game.md',
} as const
