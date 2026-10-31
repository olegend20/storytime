import { z } from 'zod'

/**
 * After the story stream drops: what the page tells the parent, and how it waits (issue #59).
 * The waiting itself follows the story so far since #82 (lib/client/resume.ts).
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
  now: () => number
  /** Resolves after `ms`, or earlier when the parent comes back to the tab. */
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
}

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

/**
 * The browser's sleep: a timer, cut short when the tab becomes visible again - a parent who
 * locked the phone and comes back should see the story move on at once, not after the next tick.
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
