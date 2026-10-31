import { describe, expect, it } from 'vitest'
import { newGenerationId, visibilityAwareSleep } from '@/lib/client/finish'

/**
 * Issue #59: after the story stream drops, the page asks about its request by the id it sent
 * with it. The waiting itself is test/unit/resume.test.ts (issue #82).
 */

describe('waiting for a story after the connection dropped (issue #59)', () => {
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

  it('makes a v4 id without crypto.randomUUID (iOS Safari before 15.4), and none without crypto', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    const legacy = { getRandomValues: <T extends ArrayBufferView | null>(a: T) => globalThis.crypto.getRandomValues(a as never) as T }
    const ids = new Set(Array.from({ length: 50 }, () => newGenerationId(legacy)))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(v4)
    expect(newGenerationId(null)).toBeNull()
    expect(newGenerationId({ getRandomValues: () => { throw new Error('insecure context') } })).toBeNull()
  })
})
