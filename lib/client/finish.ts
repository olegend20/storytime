import { z } from 'zod'

/**
 * After the story stream drops, wait for the story the server is still making (issue #59).
 *
 * The route keeps running when the parent's connection goes (it is answered by `after()`), so
 * a dropped stream is usually a story that WILL be saved - in production, 5 of 7 requests
 * between 14 and 17 October saved a story a few minutes after the phone had said "we lost the
 * connection" (a locked screen or a switched app cuts a phone's fetch). Instead of sending the
 * parent to an empty library, the page asks how its request ended and opens the story.
 *
 * It asks by the id it sent with the request (`x-generation-id`), so the answer is about THIS
 * request whatever the phone's clock says, and a discarded story (which has no `stories` row)
 * is told apart from one still being written.
 */

/** How often to ask while the tab is open. One small row read; no model call. */
export const FINISH_POLL_MS = 8_000

/**
 * The page's own backstop. The server reports a request still "writing" past its
 * `maxDuration` as failed (lib/generate/requests.ts), so this is reached only when the server
 * could not be asked at all - and then the page does not claim to know how it ended.
 */
export const FINISH_WAIT_MS = 20 * 60_000

/** `GET /api/stories/generate/:id`. Kept here, not in lib/schemas: only this page reads it. */
export const GenerationStatus = z.object({
  status: z.enum(['writing', 'ready', 'flagged', 'discarded', 'failed', 'refused']),
  story_id: z.string().uuid().nullable(),
})
export type GenerationStatus = z.infer<typeof GenerationStatus>

export interface FinishDeps {
  /** How the request ended so far; null when it is not known (404 before the record exists). */
  status: (generationId: string) => Promise<GenerationStatus | null>
  now: () => number
  /** Resolves after `ms`, or earlier when the parent comes back to the tab. */
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type FinishResult =
  | { kind: 'saved'; storyId: string }
  /** The server said it ended without a story: nothing saved, no story used. */
  | { kind: 'not_made' }
  /** The page never got an answer it can trust (offline, signed out): it says it does not know. */
  | { kind: 'unknown' }
  | { kind: 'cancelled' }

/**
 * A v4 uuid for `x-generation-id`, or null where the browser has no crypto (the route treats a
 * missing id as an older page). `crypto.randomUUID` is missing before iOS Safari 15.4.
 */
export function newGenerationId(
  c: (Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string }) | null = globalThis.crypto ?? null,
): string | null {
  try {
    if (!c) return null
    if (typeof c.randomUUID === 'function') return c.randomUUID()
    const b = c.getRandomValues(new Uint8Array(16))
    b[6] = (b[6]! & 0x0f) | 0x40
    b[8] = (b[8]! & 0x3f) | 0x80
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  } catch {
    return null
  }
}

/** Ask until the request has ended, then say how. */
export async function waitForSavedStory(
  target: { generationId: string; sentAt: number },
  deps: FinishDeps,
): Promise<FinishResult> {
  const until = target.sentAt + FINISH_WAIT_MS
  for (;;) {
    if (deps.signal?.aborted) return { kind: 'cancelled' }
    let answer: GenerationStatus | null = null
    try {
      answer = await deps.status(target.generationId)
    } catch {
      // Offline, signed out, a server error: not an answer. Ask again.
    }
    if (deps.signal?.aborted) return { kind: 'cancelled' }
    if (answer && (answer.status === 'ready' || answer.status === 'flagged') && answer.story_id) {
      return { kind: 'saved', storyId: answer.story_id }
    }
    if (answer && (answer.status === 'discarded' || answer.status === 'failed' || answer.status === 'refused')) {
      return { kind: 'not_made' }
    }
    if (deps.now() >= until) return { kind: 'unknown' }
    await deps.sleep(Math.min(FINISH_POLL_MS, Math.max(0, until - deps.now())))
  }
}

/**
 * The browser's sleep: a timer, cut short when the tab becomes visible again - a parent who
 * locked the phone and comes back should not wait up to eight more seconds for the check.
 */
export function visibilityAwareSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisible)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const onVisible = () => {
        if (document.visibilityState === 'visible') done()
      }
      const timer = setTimeout(done, ms)
      document.addEventListener('visibilitychange', onVisible)
      signal?.addEventListener('abort', done)
    })
}

/** Shown while the page waits. Not an error: nothing has gone wrong that the parent must fix. */
export const FINISHING_MESSAGE =
  "We lost the connection for a moment, but your story is still being written. Keep this page open — it'll open here as soon as it's ready."

/** The server said so: nothing was saved, and no story was used. */
export const NOT_FINISHED = {
  code: 'generation_failed',
  message: "We couldn't finish that story. Try again — this didn't use one of your stories.",
  quota_consumed: false,
  resets_at: null,
} as const

/**
 * The page could not find out. It may have been saved (and used a story), so the page neither
 * offers a retry nor says it was free: the library is where it will be if it was made.
 */
export const NOT_KNOWN = {
  code: 'still_making',
  message: "We couldn't check on your story. If it was made, it's in your library.",
  // Not known either way; the `still_making` code is what keeps the free-retry note and the
  // retry button away (needsFreeRetryNote, GenerationError), and adds the library link.
  quota_consumed: false,
  resets_at: null,
} as const
