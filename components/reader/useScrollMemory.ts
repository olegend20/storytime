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
const SAVE_INTERVAL_MS = 400

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

    let last = 0
    const persist = () => {
      if (!restored.current) return
      saveScroll(storyId, window.scrollY)
    }
    const onScroll = () => {
      const now = Date.now()
      if (now - last < SAVE_INTERVAL_MS) return
      last = now
      persist()
    }
    // `pagehide` fires on iOS Safari where `beforeunload` does not; `visibilitychange` catches
    // the app being backgrounded, which at bedtime is the common way a reader is left.
    const onLeave = () => persist()

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', onLeave)
    document.addEventListener('visibilitychange', onLeave)
    return () => {
      persist()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', onLeave)
      document.removeEventListener('visibilitychange', onLeave)
    }
  }, [storyId, ready])
}
