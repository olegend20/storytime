'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { z } from 'zod'
import { readRaw, subscribeKey } from './localStore'
import { parseStored } from './storage'

/**
 * Read a JSON value out of localStorage as React state.
 *
 * `useSyncExternalStore` rather than `useEffect` + `setState`: it renders the server snapshot
 * during hydration and the real value immediately after, with no cascading render and no wrong
 * first paint, and a write from anywhere (or from another tab) re-renders every reader of that key.
 *
 * The snapshot is the raw string, because `getSnapshot` must be referentially stable; parsing
 * happens in a `useMemo` keyed on that string.
 */
export function useStoredJson<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  const subscribe = useCallback((listener: () => void) => subscribeKey(key, listener), [key])
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    // On the server there is no storage, so the fallback is the honest answer.
    () => null,
  )
  return useMemo(() => parseStored(raw, schema, fallback), [raw, schema, fallback])
}
