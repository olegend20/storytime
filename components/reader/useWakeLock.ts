'use client'

import { useEffect } from 'react'
import { createWakeLock } from '@/lib/client/wakeLock'

/** Hold the screen while `active`; re-acquire when the tab becomes visible again. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined') return
    const lock = createWakeLock(navigator as unknown as Parameters<typeof createWakeLock>[0])
    const onVisible = () => {
      if (document.visibilityState === 'visible') void lock.acquire()
    }
    void lock.acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      void lock.release()
    }
  }, [active])
}
