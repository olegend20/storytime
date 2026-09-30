/**
 * Keep the phone's screen on while a story is open (DECISIONS #143).
 *
 * A phone locks after 30-60 s without a touch, and a bedtime reader does not touch the
 * screen for a whole chapter. The Screen Wake Lock API holds the screen while the story is
 * on screen and the tab is visible; the browser releases it when the tab is hidden, so it
 * is re-requested on return. Unsupported browsers simply do nothing.
 *
 * Pure controller over a navigator-shaped object, so the behaviour is unit-tested without a
 * browser; the React hook in components/reader/useWakeLock.ts is a thin wrapper.
 */

export interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

export interface WakeLockNavigatorLike {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> }
}

export interface WakeLockController {
  /** Request the lock. Safe to call repeatedly; no-op when held or unsupported. */
  acquire(): Promise<void>
  release(): Promise<void>
  readonly held: boolean
  readonly supported: boolean
}

export function createWakeLock(nav: WakeLockNavigatorLike): WakeLockController {
  let sentinel: WakeLockSentinelLike | null = null
  let wanted = false
  const supported = typeof nav.wakeLock?.request === 'function'

  return {
    get supported() {
      return supported
    },
    get held() {
      return sentinel !== null && !sentinel.released
    },
    async acquire() {
      wanted = true
      if (!supported || this.held) return
      try {
        const next = await nav.wakeLock!.request('screen')
        if (!wanted) {
          await next.release()
          return
        }
        sentinel = next
        next.addEventListener('release', () => {
          if (sentinel === next) sentinel = null
        })
      } catch {
        // Denied (low battery, a policy) - nothing to do; reading still works.
        sentinel = null
      }
    },
    async release() {
      wanted = false
      const current = sentinel
      sentinel = null
      if (current && !current.released) await current.release()
    },
  }
}
