'use client'

import { useEffect } from 'react'

/**
 * Registers the service worker (public/sw.js) so saved stories read without a signal
 * (DECISIONS #145). Production builds only: in `next dev` a worker fights hot reloading.
 */
export function OfflineReady() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // No offline reading in this browser; everything else is unaffected.
    })
  }, [])
  return null
}
