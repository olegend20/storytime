'use client'

import { useCallback, useMemo } from 'react'
import {
  DEFAULT_READING_PREFS,
  PREFS_KEY,
  ReadingPrefs,
  TEXT_SCALES,
  saveReadingPrefs,
  type Theme,
} from '@/lib/client/storage'
import { useStoredJson } from '@/lib/client/useStored'

/**
 * The three reading preferences, backed by localStorage directly.
 *
 * No context provider: the store already broadcasts, so every component that reads the key stays
 * in sync without one. `ThemeScript` has applied these to <html> before first paint, so the
 * setters' job is to keep the DOM and the stored value together from then on.
 */
export interface PrefsApi {
  prefs: ReadingPrefs
  setTheme: (theme: Theme) => void
  setReadingMode: (on: boolean) => void
  setTextScaleIndex: (index: number) => void
}

function applyToDocument(prefs: ReadingPrefs): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (prefs.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', prefs.theme)
  if (prefs.readingMode) root.setAttribute('data-reading', 'on')
  else root.removeAttribute('data-reading')
  root.style.setProperty('--text-scale', String(TEXT_SCALES[prefs.textScaleIndex] ?? 1))
}

export function usePrefs(): PrefsApi {
  const prefs = useStoredJson(PREFS_KEY, ReadingPrefs, DEFAULT_READING_PREFS)

  const update = useCallback(
    (patch: Partial<ReadingPrefs>) => {
      const next = { ...prefs, ...patch }
      applyToDocument(next)
      saveReadingPrefs(next)
    },
    [prefs],
  )

  return useMemo(
    () => ({
      prefs,
      setTheme: (theme: Theme) => update({ theme }),
      setReadingMode: (readingMode: boolean) => update({ readingMode }),
      setTextScaleIndex: (index: number) =>
        update({ textScaleIndex: Math.min(Math.max(index, 0), TEXT_SCALES.length - 1) }),
    }),
    [prefs, update],
  )
}
