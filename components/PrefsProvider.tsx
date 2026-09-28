'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_READING_PREFS,
  TEXT_SCALES,
  loadReadingPrefs,
  saveReadingPrefs,
  type ReadingPrefs,
  type Theme,
} from '@/lib/client/storage'

/**
 * Owns the three reading preferences and keeps <html> in sync with them.
 *
 * `ThemeScript` has already applied the stored values before paint, so this provider's job is
 * to let the controls change them and to write them back. The DOM - not React state - is the
 * source of truth for what the page currently looks like, which is why the initial state is read
 * back off <html> rather than from localStorage a second time.
 */

interface PrefsContext {
  prefs: ReadingPrefs
  setTheme: (theme: Theme) => void
  setReadingMode: (on: boolean) => void
  setTextScaleIndex: (index: number) => void
  /** True once the stored values have been read, so a control can avoid a wrong first paint. */
  hydrated: boolean
}

const Ctx = createContext<PrefsContext | null>(null)

function applyToDocument(prefs: ReadingPrefs): void {
  const root = document.documentElement
  if (prefs.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', prefs.theme)
  if (prefs.readingMode) root.setAttribute('data-reading', 'on')
  else root.removeAttribute('data-reading')
  const scale = TEXT_SCALES[prefs.textScaleIndex] ?? 1
  root.style.setProperty('--text-scale', String(scale))
}

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<ReadingPrefs>(DEFAULT_READING_PREFS)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setPrefs(loadReadingPrefs())
    setHydrated(true)
  }, [])

  const update = useCallback((patch: Partial<ReadingPrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      applyToDocument(next)
      saveReadingPrefs(next)
      return next
    })
  }, [])

  const value = useMemo<PrefsContext>(
    () => ({
      prefs,
      hydrated,
      setTheme: (theme) => update({ theme }),
      setReadingMode: (readingMode) => update({ readingMode }),
      setTextScaleIndex: (textScaleIndex) =>
        update({
          textScaleIndex: Math.min(Math.max(textScaleIndex, 0), TEXT_SCALES.length - 1),
        }),
    }),
    [prefs, hydrated, update],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePrefs(): PrefsContext {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePrefs must be used inside <PrefsProvider>')
  return ctx
}
