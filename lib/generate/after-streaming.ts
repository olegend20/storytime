import type { QualityResult, StoryOutput } from '@/lib/schemas'

/**
 * What the parent saw happen to the story after it began streaming (issue #85): nothing, a
 * few sentences edited in place (the mend, the cut or the revision), or the whole story
 * replaced by a rewrite or a shorter retry.
 *
 * Here, not in `lib/eval`, since issue #132: the owner's writer trial records it for each
 * saved story, and nothing in the request path may import the eval harness. The eval reads
 * the same function, so a trial book and an eval story are counted the same way.
 */
export type AfterStreaming = 'unchanged' | 'edited' | 'replaced'

/**
 * Read from the stories themselves: a new title or new headings is a replaced story (a
 * rewrite), the same ones with different text an edited one. A lost rewrite that fell back to
 * attempt 1 (#72) is not replaced, whatever the ladder did to it after. Rung 3's shorter retry
 * is replaced: the unusable draft streamed first. Without the stories, the gate's record is
 * the guess.
 */
export function afterStreaming(quality: QualityResult, first?: StoryOutput, delivered?: StoryOutput): AfterStreaming {
  if ((quality.first_attempt?.reasons ?? []).some((r) => r.startsWith('output unusable; retried'))) return 'replaced'
  if (first && delivered) {
    const outline = (s: StoryOutput) => JSON.stringify([s.title, s.subtitle, s.chapters.map((c) => c.heading)])
    const body = (s: StoryOutput) => JSON.stringify([s.chapters.map((c) => c.text), s.ending_line, s.true_facts])
    if (outline(first) !== outline(delivered)) return 'replaced'
    return body(first) !== body(delivered) ? 'edited' : 'unchanged'
  }
  const fellBack = quality.rewrite_reasons.some((r) => r.startsWith('rewrite output unusable'))
  if (quality.attempt === 2 && !fellBack) return 'replaced'
  return (quality.mended?.edits ?? 0) + (quality.mended?.cut ?? 0) > 0 ? 'edited' : 'unchanged'
}

/**
 * "First draft untouched", the owner's hill-climb count (2026-10-08): one writing call, the
 * gate sent nothing back, no hard rule was mended, and the text the parent read is the text
 * that was saved.
 */
export function firstDraftUntouched(quality: QualityResult, writeCalls: number, after: AfterStreaming): boolean {
  return (
    writeCalls <= 1 &&
    (quality.first_attempt ?? null) === null &&
    (quality.mended?.rules ?? []).length === 0 &&
    after === 'unchanged' &&
    quality.outcome !== 'discarded'
  )
}
