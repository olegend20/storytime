import type { LibraryStory } from '@/lib/schemas'

/**
 * After the story stream drops, wait for the story the server is still making (issue #59).
 *
 * The route keeps running when the parent's connection goes (it is answered by `after()`), so
 * a dropped stream is usually a story that WILL be saved - in production, 5 of 7 requests
 * between 14 and 17 October saved a story a few minutes after the phone had said "we lost the
 * connection" (a locked screen or a switched app cuts a phone's fetch). Instead of sending the
 * parent to an empty library, the page looks for the story itself and opens it when it lands.
 *
 * The story is found by its id when the `meta` event arrived (a saved story answers
 * `GET /api/stories/{id}`; 404 means still being written), and otherwise by being the newest
 * library story created since the request was sent.
 */

/** How often to look while the tab is open. A story row is one cheap read; no model call. */
export const FINISH_POLL_MS = 8_000

/**
 * How long to keep looking: past the generation route's `maxDuration` (800 s) with a margin
 * for the gate and the save. After this the server has given up too, so no story is coming.
 * test/unit/deploy-config.test.ts ties it to the route.
 */
export const FINISH_WAIT_MS = 15 * 60_000

/** Server and phone clocks differ; a story created this long before "sent" still counts. */
const CLOCK_SKEW_MS = 60_000

export interface FinishTarget {
  /** From the `meta` event; null when the stream dropped before it. */
  storyId: string | null
  /** Epoch ms the request was sent. */
  sentAt: number
}

export interface FinishDeps {
  /** True when the story with this id is saved; false while it is still being written (404). */
  isSaved: (id: string) => Promise<boolean>
  library: () => Promise<readonly Pick<LibraryStory, 'id' | 'created_at'>[]>
  now: () => number
  /** Resolves after `ms`, or earlier when the parent comes back to the tab. */
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type FinishResult = { kind: 'saved'; storyId: string } | { kind: 'gave_up' } | { kind: 'cancelled' }

/** One look. A failed read (the phone is still offline) counts as "not yet". */
export async function findSavedStory(target: FinishTarget, deps: Pick<FinishDeps, 'isSaved' | 'library'>): Promise<string | null> {
  try {
    if (target.storyId) return (await deps.isSaved(target.storyId)) ? target.storyId : null
    const since = target.sentAt - CLOCK_SKEW_MS
    const newest = (await deps.library())
      .filter((s) => Date.parse(s.created_at) >= since)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
    return newest?.id ?? null
  } catch {
    return null
  }
}

/** Look now, then every `FINISH_POLL_MS`, until the story is saved or the server has given up. */
export async function waitForSavedStory(target: FinishTarget, deps: FinishDeps): Promise<FinishResult> {
  const until = target.sentAt + FINISH_WAIT_MS
  for (;;) {
    if (deps.signal?.aborted) return { kind: 'cancelled' }
    const id = await findSavedStory(target, deps)
    if (deps.signal?.aborted) return { kind: 'cancelled' }
    if (id) return { kind: 'saved', storyId: id }
    if (deps.now() >= until) return { kind: 'gave_up' }
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

/** The server gave up too: nothing was saved, and no story was used. */
export const NOT_FINISHED = {
  code: 'generation_failed',
  message: "We couldn't finish that story. Try again — this didn't use one of your stories.",
  quota_consumed: false,
  resets_at: null,
} as const
