import { describe, expect, it } from 'vitest'
import {
  FINISH_POLL_MS,
  FINISH_WAIT_MS,
  visibilityAwareSleep,
  waitForSavedStory,
  type FinishDeps,
  type GenerationStatus,
} from '@/lib/client/finish'

/**
 * Issue #59: after the story stream drops, the page asks how its request ended (by the id it
 * sent with it) and opens the story, instead of sending the parent to a library the story has
 * not reached yet.
 */

const SENT = Date.parse('2026-10-17T16:17:46Z')
const GEN = 'a5f0c3d2-1b4e-4c8a-9f6d-2e7b8c9d0a1b'
const STORY = '791b81fe-4fcb-4172-af1f-6eacf91aefda'
const target = { generationId: GEN, sentAt: SENT }

/** A clock that only moves when the waiter sleeps, and a server that answers by the clock. */
function fakeDeps(answer: (elapsedMs: number) => GenerationStatus | null | Error, over: Partial<FinishDeps> = {}) {
  let now = SENT + 180_000 // the drop came three minutes in, as on the owner's phone
  const asked: string[] = []
  const sleeps: number[] = []
  const deps: FinishDeps = {
    status: async (id) => {
      asked.push(id)
      const a = answer(now - SENT)
      if (a instanceof Error) throw a
      return a
    },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
    ...over,
  }
  return { deps, asked, sleeps, clock: () => now }
}

const writing: GenerationStatus = { status: 'writing', story_id: null }

describe('waiting for a story after the connection dropped (issue #59)', () => {
  it('a dropped stream waits for that request and opens its story when it is saved', async () => {
    // Volcanoes, 2026-10-17: saved 6½ minutes after it was asked for.
    const { deps, asked, sleeps, clock } = fakeDeps((t) =>
      t >= 390_000 ? { status: 'ready', story_id: STORY } : writing,
    )
    expect(await waitForSavedStory(target, deps)).toEqual({ kind: 'saved', storyId: STORY })
    expect(new Set(asked)).toEqual(new Set([GEN]))
    expect(sleeps.every((ms) => ms <= FINISH_POLL_MS)).toBe(true)
    expect(clock() - SENT).toBeLessThan(390_000 + FINISH_POLL_MS + 1)
  })

  it('a flagged story opens too: it is saved and shown with its banner', async () => {
    const { deps } = fakeDeps(() => ({ status: 'flagged', story_id: STORY }))
    expect(await waitForSavedStory(target, deps)).toEqual({ kind: 'saved', storyId: STORY })
  })

  it('a story the server discarded is reported at once, not after the whole wait', async () => {
    for (const status of ['discarded', 'failed', 'refused'] as const) {
      const { deps, clock } = fakeDeps((t) => (t >= 240_000 ? { status, story_id: null } : writing))
      expect(await waitForSavedStory(target, deps)).toEqual({ kind: 'not_made' })
      expect(clock() - SENT).toBeLessThan(240_000 + FINISH_POLL_MS + 1)
    }
  })

  it('no record yet (404) and errors count as "not yet", never as an answer', async () => {
    const { deps } = fakeDeps((t) =>
      t < 200_000 ? null : t < 230_000 ? new TypeError('Load failed') : { status: 'ready', story_id: STORY },
    )
    expect(await waitForSavedStory(target, deps)).toEqual({ kind: 'saved', storyId: STORY })
  })

  it('never answered (offline, signed out): it says it does not know, not that the story was free', async () => {
    const { deps, clock } = fakeDeps(() => new Error('401'))
    expect(await waitForSavedStory(target, deps)).toEqual({ kind: 'unknown' })
    expect(clock()).toBeGreaterThanOrEqual(SENT + FINISH_WAIT_MS)
    expect(clock()).toBeLessThanOrEqual(SENT + FINISH_WAIT_MS + FINISH_POLL_MS)
  })

  it('stops asking when the parent leaves the page', async () => {
    const controller = new AbortController()
    const { deps } = fakeDeps(() => writing, { signal: controller.signal, sleep: async () => controller.abort() })
    expect(await waitForSavedStory(target, deps)).toEqual({ kind: 'cancelled' })
  })

  it('coming back to the tab asks at once', async () => {
    let state: DocumentVisibilityState = 'hidden'
    const listeners = new Set<() => void>()
    const doc = {
      get visibilityState() {
        return state
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }
    const original = globalThis.document
    Object.defineProperty(globalThis, 'document', { value: doc, configurable: true })
    try {
      const started = Date.now()
      const slept = visibilityAwareSleep()(60_000)
      state = 'visible'
      for (const fn of [...listeners]) fn()
      await slept
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(listeners.size).toBe(0)
    } finally {
      Object.defineProperty(globalThis, 'document', { value: original, configurable: true })
    }
  })
})
