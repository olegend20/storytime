import { describe, expect, it } from 'vitest'
import { FINISH_POLL_MS, FINISH_WAIT_MS, findSavedStory, waitForSavedStory, type FinishDeps } from '@/lib/client/finish'

/**
 * Issue #59: after the story stream drops, the page waits for the story the server is still
 * making and opens it, instead of sending the parent to a library it has not reached yet.
 */

const SENT = Date.parse('2026-10-17T16:17:46Z')
const ID = '791b81fe-4fcb-4172-af1f-6eacf91aefda'

/** A clock that only moves when the waiter sleeps, and a record of every look. */
function fakeDeps(over: Partial<FinishDeps> = {}) {
  let now = SENT + 180_000 // the drop came three minutes in, as on the owner's phone
  const sleeps: number[] = []
  const deps: FinishDeps = {
    isSaved: async () => false,
    library: async () => [],
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms)
      now += ms
    },
    ...over,
  }
  return { deps, sleeps, advance: (ms: number) => (now += ms), clock: () => now }
}

describe('waiting for a story after the connection dropped (issue #59)', () => {
  it('a dropped stream after meta waits for that story and opens it when it is saved', async () => {
    const looks: string[] = []
    const savedAt = SENT + 390_000 // volcanoes, 2026-10-17: saved 6½ minutes after it was asked for
    const { deps, sleeps, clock } = fakeDeps()
    deps.isSaved = async (id) => {
      looks.push(id)
      return clock() >= savedAt
    }

    const result = await waitForSavedStory({ storyId: ID, sentAt: SENT }, deps)

    expect(result).toEqual({ kind: 'saved', storyId: ID })
    expect(new Set(looks)).toEqual(new Set([ID]))
    expect(sleeps.every((ms) => ms <= FINISH_POLL_MS)).toBe(true)
    expect(clock()).toBeLessThan(savedAt + FINISH_POLL_MS + 1)
  })

  it('a dropped stream before meta finds the new story in the library by its creation time', async () => {
    const older = { id: 'older', created_at: '2026-10-17T05:07:03Z' }
    const fresh = { id: ID, created_at: '2026-10-17T16:24:10Z' }
    let calls = 0
    const { deps } = fakeDeps({
      library: async () => (++calls < 3 ? [older] : [older, fresh]),
    })

    expect(await findSavedStory({ storyId: null, sentAt: SENT }, { ...deps, library: async () => [older] })).toBeNull()
    expect(await waitForSavedStory({ storyId: null, sentAt: SENT }, deps)).toEqual({ kind: 'saved', storyId: ID })
  })

  it('a phone still offline counts as "not yet", not as a failure', async () => {
    let n = 0
    const { deps } = fakeDeps({
      isSaved: async () => {
        n += 1
        if (n < 3) throw new TypeError('Load failed')
        return true
      },
    })
    expect(await waitForSavedStory({ storyId: ID, sentAt: SENT }, deps)).toEqual({ kind: 'saved', storyId: ID })
  })

  it("waiting gives up after the request deadline and says it didn't use a story", async () => {
    const { deps, clock } = fakeDeps()
    const result = await waitForSavedStory({ storyId: ID, sentAt: SENT }, deps)
    expect(result).toEqual({ kind: 'gave_up' })
    // Not a moment before the server itself has given up.
    expect(clock()).toBeGreaterThanOrEqual(SENT + FINISH_WAIT_MS)
    expect(clock()).toBeLessThanOrEqual(SENT + FINISH_WAIT_MS + FINISH_POLL_MS)
  })

  it('stops looking when the parent leaves the page', async () => {
    const controller = new AbortController()
    const { deps } = fakeDeps({
      signal: controller.signal,
      sleep: async () => controller.abort(),
    })
    expect(await waitForSavedStory({ storyId: ID, sentAt: SENT }, deps)).toEqual({ kind: 'cancelled' })
  })

  it('coming back to the tab checks at once', async () => {
    const { visibilityAwareSleep } = await import('@/lib/client/finish')
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
