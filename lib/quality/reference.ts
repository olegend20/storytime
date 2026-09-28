import { STORY_MAX_CHAPTERS, type StoryOutput } from '@/lib/schemas'
import { asStoryOutput, type ParsedReference } from '@/lib/reference'

/**
 * Map a parsed reference story onto the shape a *generated* story has, so the four
 * references can go through the F7 deterministic gate unchanged (F7 VT).
 *
 * Two differences between reference markdown and `StoryOutput` have to be reconciled, and
 * both are recorded decisions rather than fudges:
 *
 *  - **The cold open.** §4.1.2 mandates one; §4.4 has no field for it, so a generated story
 *    folds it into `chapters[0]` (DECISIONS.md #18). The LEGO and shark references write it
 *    as unheaded prose before "Chapter 1", and `lib/reference.ts` parses it into
 *    `coldOpen` - which `asStoryOutput` drops. Prepending it here is what makes the gate's
 *    word count match the reference test's `narrativeWordCount`.
 *
 *  - **Headed cold opens and codas.** Two references head their opening and/or their
 *    return-home coda ("Loading...", "Kickoff", "Game Over? Not Quite.", "Full Time"), so
 *    they carry 11 headed sections while `StoryOutput` caps `chapters` at 10
 *    (DECISIONS.md #25). Those sections are not journey stops, so folding them into the
 *    neighbouring chapter is the same mapping a generated story would already have.
 *
 * Nothing else is changed: no text is rewritten, no fact id invented.
 */

/** A heading that names a numbered stop on the journey. */
export function isJourneyStop(heading: string): boolean {
  return /\b(?:chapter|level|stop|part|step)\s*\d/i.test(heading)
}

export function foldReferenceChapters(
  chapters: readonly { heading: string; text: string }[],
  max: number = STORY_MAX_CHAPTERS,
): { heading: string; text: string }[] {
  const out = chapters.map((c) => ({ ...c }))
  while (out.length > max) {
    const first = out[0]!
    const last = out[out.length - 1]!
    if (!isJourneyStop(first.heading) && out.length > 1) {
      const next = out[1]!
      next.text = `${first.text}\n\n${next.text}`.trim()
      out.shift()
      continue
    }
    if (!isJourneyStop(last.heading) && out.length > 1) {
      const prev = out[out.length - 2]!
      prev.text = `${prev.text}\n\n${last.text}`.trim()
      out.pop()
      continue
    }
    // Every section is a numbered stop: fold the last two rather than lose one.
    const prev = out[out.length - 2]!
    prev.text = `${prev.text}\n\n${last.text}`.trim()
    out.pop()
  }
  return out
}

export function referenceStoryOutput(parsed: ParsedReference): StoryOutput {
  const base = asStoryOutput(parsed)
  const chapters = foldReferenceChapters(base.chapters)

  if (parsed.coldOpen.trim() !== '' && chapters.length > 0) {
    const first = chapters[0]!
    first.text = `${parsed.coldOpen.trim()}\n\n${first.text}`.trim()
  }

  return {
    ...base,
    chapters: chapters.map((c) => ({ heading: c.heading, text: c.text, shout_line: null })),
  }
}
