import { describe, expect, it } from 'vitest'
import { createWakeLock, type WakeLockSentinelLike } from '@/lib/client/wakeLock'

/** The screen stays on while a story is open (DECISIONS #143). */
function fakeNavigator(opts: { deny?: boolean } = {}) {
  const requests: WakeLockSentinelLike[] = []
  return {
    requests,
    nav: {
      wakeLock: {
        async request() {
          if (opts.deny) throw new Error('NotAllowedError')
          const listeners: (() => void)[] = []
          const sentinel: WakeLockSentinelLike & { fire(): void } = {
            released: false,
            async release() {
              this.released = true
              listeners.forEach((l) => l())
            },
            addEventListener(_t, l) {
              listeners.push(l)
            },
            fire() {
              this.released = true
              listeners.forEach((l) => l())
            },
          }
          requests.push(sentinel)
          return sentinel
        },
      },
    },
  }
}

describe('createWakeLock', () => {
  it('holds the screen once, and releases it on request', async () => {
    const { nav, requests } = fakeNavigator()
    const lock = createWakeLock(nav)
    expect(lock.supported).toBe(true)
    await lock.acquire()
    await lock.acquire()
    expect(requests).toHaveLength(1)
    expect(lock.held).toBe(true)
    await lock.release()
    expect(lock.held).toBe(false)
    expect(requests[0]!.released).toBe(true)
  })

  it('re-acquires after the browser released it (tab hidden, then shown)', async () => {
    const { nav, requests } = fakeNavigator()
    const lock = createWakeLock(nav)
    await lock.acquire()
    ;(requests[0] as WakeLockSentinelLike & { fire(): void }).fire()
    expect(lock.held).toBe(false)
    await lock.acquire()
    expect(requests).toHaveLength(2)
    expect(lock.held).toBe(true)
  })

  it('does nothing where the API is missing or denied', async () => {
    const none = createWakeLock({})
    expect(none.supported).toBe(false)
    await none.acquire()
    expect(none.held).toBe(false)
    const denied = createWakeLock(fakeNavigator({ deny: true }).nav)
    await denied.acquire()
    expect(denied.held).toBe(false)
  })
})
