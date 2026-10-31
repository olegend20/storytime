import { z } from 'zod'
import { SseEvent } from '@/lib/schemas'
import { FINISH_WAIT_MS, GenerationStatus, type FinishDeps } from './finish'

/**
 * After the story stream drops, follow the story the server is still writing (issue #82).
 *
 * A locked phone or a switched app cuts the page's fetch, while the server keeps writing (#59).
 * The page cannot rejoin that stream, so it reads the story so far by the id it sent with the
 * request, rebuilds the reader from it, and keeps asking until the story ends: the chapters carry
 * on appearing where they stopped, and a story that finished while the phone was locked is there,
 * finished, in the same reader. #59's answers stay as the fallback when there is no snapshot.
 */

/** How often to ask while the tab is open. Two small row reads; no model call. */
export const RESUME_POLL_MS = 2_000

/** `GET /api/stories/generate/:id/progress`. Kept here, not in lib/schemas: only this page reads it. */
export const GenerationProgress = GenerationStatus.extend({
  version: z.number().int().nonnegative(),
  events: z.array(z.unknown()).nullable(),
})
export type GenerationProgress = z.infer<typeof GenerationProgress>

export interface ResumeDeps extends FinishDeps {
  /** The story so far, newer than `after`; null when it is not known (404 before the record exists). */
  progress: (generationId: string, after: number) => Promise<GenerationProgress | null>
  /** Rebuild the reader from the story so far. */
  apply: (events: SseEvent[]) => void
}

export type ResumeResult =
  /** The story so far ended in `done` or `error`: the reader already shows how it ended. */
  | { kind: 'ended' }
  /** Saved with no snapshot to show it from: open the saved story. */
  | { kind: 'saved'; storyId: string }
  | { kind: 'not_made' }
  | { kind: 'unknown' }
  | { kind: 'cancelled' }

/** Ask until the request has ended, rebuilding the reader each time the story has moved on. */
export async function resumeStory(
  target: { generationId: string; sentAt: number },
  deps: ResumeDeps,
): Promise<ResumeResult> {
  const until = target.sentAt + FINISH_WAIT_MS
  let version = 0
  for (;;) {
    if (deps.signal?.aborted) return { kind: 'cancelled' }
    let answer: GenerationProgress | null = null
    try {
      answer = await deps.progress(target.generationId, version)
    } catch {
      // Offline, signed out, a server error: not an answer. Ask again.
    }
    if (deps.signal?.aborted) return { kind: 'cancelled' }
    if (answer?.events && answer.version > version) {
      // Unknown or malformed events are skipped, as on the live stream.
      const events = answer.events.flatMap((raw) => {
        const parsed = SseEvent.safeParse(raw)
        return parsed.success ? [parsed.data] : []
      })
      version = answer.version
      deps.apply(events)
      const last = events.at(-1)
      if (last?.type === 'done' || last?.type === 'error') return { kind: 'ended' }
    }
    if (answer && (answer.status === 'ready' || answer.status === 'flagged') && answer.story_id) {
      return { kind: 'saved', storyId: answer.story_id }
    }
    if (answer && (answer.status === 'discarded' || answer.status === 'failed' || answer.status === 'refused')) {
      return { kind: 'not_made' }
    }
    if (deps.now() >= until) return { kind: 'unknown' }
    await deps.sleep(Math.min(RESUME_POLL_MS, Math.max(0, until - deps.now())))
  }
}
