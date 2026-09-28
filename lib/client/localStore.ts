/**
 * localStorage as a subscribable store.
 *
 * React's rules (and the `react-hooks/set-state-in-effect` lint) are right about this:
 * localStorage is an external system, not initial state. Reading it in an effect and calling
 * setState causes a cascading render and a wrong first paint; reading it during render breaks
 * server rendering. The correct shape is a store with `subscribe` + `getSnapshot`, which is what
 * this is.
 *
 * `getSnapshot` must return a referentially stable value or React re-renders forever, so the
 * cache holds the RAW STRING and callers parse it behind a `useMemo`. Every access is wrapped:
 * private windows and blocked site data throw on the property itself.
 */

type Listener = () => void

const cache = new Map<string, string | null>()
const listeners = new Map<string, Set<Listener>>()

/**
 * There is no storage on the server. The explicit check is not belt-and-braces: Node ships a
 * `localStorage` stub that prints a warning on every access, which would fill the build log.
 */
function available(): boolean {
  return typeof window !== 'undefined'
}

function safeGet(key: string): string | null {
  if (!available()) return null
  try {
    return window.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): void {
  if (!available()) return
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    /* full or unavailable - a lost preference is not worth breaking the page for */
  }
}

function safeRemove(key: string): void {
  if (!available()) return
  try {
    window.localStorage?.removeItem(key)
  } catch {
    /* ignore */
  }
}

function notify(key: string): void {
  const set = listeners.get(key)
  if (!set) return
  for (const listener of [...set]) listener()
}

/** Cached raw read. `null` on a miss, on a throw, and on the server. */
export function readRaw(key: string): string | null {
  if (!cache.has(key)) cache.set(key, safeGet(key))
  return cache.get(key) ?? null
}

export function writeRaw(key: string, value: string): void {
  if (cache.get(key) === value) return
  safeSet(key, value)
  cache.set(key, value)
  notify(key)
}

export function removeRaw(key: string): void {
  safeRemove(key)
  cache.set(key, null)
  notify(key)
}

export function subscribeKey(key: string, listener: Listener): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
    if (set && set.size === 0) listeners.delete(key)
  }
}

/** Another tab changed something - drop the cached value and tell anyone watching that key. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null) {
      // Storage was cleared wholesale.
      const keys = [...cache.keys()]
      cache.clear()
      for (const key of keys) notify(key)
      return
    }
    cache.delete(event.key)
    notify(event.key)
  })
}

/** Test seam: drop the in-process cache without touching the browser's storage. */
export function __clearLocalStoreCache(): void {
  cache.clear()
}
