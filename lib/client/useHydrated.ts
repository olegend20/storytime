'use client'

import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}

/**
 * False on the server and during hydration, true from the first client render after it.
 *
 * For anything that depends on the reader's own clock or locale - a time shown as "4:00 PM" -
 * which the server cannot know and must not guess: rendering it only once hydrated keeps the
 * server and client markup identical.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false)
}
