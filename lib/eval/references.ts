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
 *  1. It folds the cold open into `chapters[0].text`. DECISIONS.md #18 says the cold open
 *     IS the opening of the first chapter, but `asStoryOutput()` drops `coldOpen`
 *     entirely - which loses 110 words of the LEGO story and 259 of the shark story, and
 *     makes the judge score an opening that starts at "Chapter 1". Folding it back in is
 *     the fix; flagged to the lead as a likely bug in `asStoryOutput()`.
 *  2. It returns `JudgeableStory`, not `StoryOutput`. Two of the four references carry 11
 *     headed sections and do not validate against `StoryOutput` (DECISIONS.md #25), so
 *     scoring the calibration set through the strict schema would throw on half of it.
 */

export interface ReferenceCase {
  entry: ReferenceEntry
  parsed: ParsedReference
  story: JudgeableStory
  context: JudgeContext
  wordCount: number
}

/** Fold the cold open into chapter 1, per DECISIONS.md #18. */
export function toJudgeable(parsed: ParsedReference): JudgeableStory {
  const out = asStoryOutput(parsed)
  const chapters = out.chapters.map((c) => ({ ...c }))
  const coldOpen = parsed.coldOpen.trim()
  if (coldOpen !== '' && chapters.length > 0) {
    const first = chapters[0]!
    chapters[0] = { ...first, text: `${coldOpen}\n\n${first.text}` }
  }
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
