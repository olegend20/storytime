'use client'

import { useEffect, useRef } from 'react'
import { loadScroll, saveScroll } from '@/lib/client/storage'

/**
 * F9: "remembers scroll position per story in localStorage", verified by
 * "reload mid-story restores scroll position within 200px".
 *
 * Two details make that test pass reliably rather than usually:
 *
 * 1. `history.scrollRestoration = 'manual'`. The browser's own restoration races ours and wins
 *    sometimes, which is exactly the flake you cannot reproduce locally.
 * 2. A short retry loop. `window.scrollTo` clamps to the current document height, and on a
 *    reload the story arrives from `fetch` - fonts and layout settle over several frames, so a
 *    single scroll call lands short on a long story. We re-apply until the position sticks.
 *
 * Saving is suppressed until the restore has happened; otherwise the first scroll event after a
 * reload would overwrite the stored position with 0.
 */

const RESTORE_ATTEMPTS = 20
const RESTORE_TOLERANCE_PX = 8
/** Trailing, not leading: what matters is where the reader came to rest. */
const SAVE_DEBOUNCE_MS = 250

export function useScrollMemory(storyId: string | null, ready: boolean): void {
  const restored = useRef(false)

  useEffect(() => {
    if (!storyId || !ready) return
    restored.current = false

    if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

    const saved = loadScroll(storyId)
    const target = saved?.y ?? 0

    let cancelled = false
    let attempts = 0

    const settle = () => {
      if (cancelled) return
      if (target <= 0) {
        restored.current = true
        return
      }
      window.scrollTo({ top: target, behavior: 'auto' })
      attempts += 1
      const close = Math.abs(window.scrollY - target) <= RESTORE_TOLERANCE_PX
      // Also stop if the page simply cannot scroll that far - the story got shorter.
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight
      if (close || attempts >= RESTORE_ATTEMPTS || target > maxScroll + RESTORE_TOLERANCE_PX) {
        restored.current = true
        return
      }
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(() => requestAnimationFrame(settle))

    return () => {
      cancelled = true
    }
  }, [storyId, ready])

  useEffect(() => {
    if (!storyId || !ready) return

    let timer: ReturnType<typeof setTimeout> | null = null

    const persist = () => {
      // Suppressed until the restore has finished, or the first scroll event after a reload would
      // overwrite the stored position with 0.
      if (!restored.current) return
      saveScroll(storyId, window.scrollY)
    }

    /**
     * Debounced, and deliberately not throttled.
     *
     * A leading throttle loses the position whenever scrolling stops inside the window - it saves
     * where the reader started moving and never where they stopped. Worse, if the very first event
     * arrives before the restore has settled, `persist` is skipped and the throttle has already
     * swallowed the next one, so nothing is saved at all. A trailing timer always records the
     * resting position.
     */
    const onScroll = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(persist, SAVE_DEBOUNCE_MS)
    }

    // `pagehide` fires on iOS Safari where `beforeunload` does not; `visibilitychange` catches the
    // app being backgrounded, which at bedtime is the usual way a reader is left.
    const onLeave = () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      persist()
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', onLeave)
    document.addEventListener('visibilitychange', onLeave)
    return () => {
      if (timer !== null) clearTimeout(timer)
      persist()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', onLeave)
      document.removeEventListener('visibilitychange', onLeave)
    }
  }, [storyId, ready])
}
