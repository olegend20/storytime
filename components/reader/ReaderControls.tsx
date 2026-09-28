'use client'

import { usePrefs } from '@/components/PrefsProvider'
import { ThemeToggle } from '@/components/ThemeToggle'
import { TEXT_SCALES } from '@/lib/client/storage'

/**
 * The reader's own controls: reading mode, text size, theme.
 *
 * Reading mode and text size stay visible in reading mode - they are how you get back out and
 * how you fix the size once you are in. Everything else is chrome and disappears.
 */
export function ReaderControls({ children }: { children?: React.ReactNode }) {
  const { prefs, setReadingMode, setTextScaleIndex } = usePrefs()
  const index = prefs.textScaleIndex

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn btn-quiet"
        onClick={() => setReadingMode(!prefs.readingMode)}
      >
        <span data-when-reading="off">Reading mode</span>
        <span data-when-reading="on">Done reading</span>
      </button>

      <div
        role="group"
        aria-label="Text size"
        className="inline-flex items-center gap-1 rounded-full border border-line p-1"
      >
        <button
          type="button"
          className="tap rounded-full px-3"
          aria-label="Smaller text"
          disabled={index <= 0}
          onClick={() => setTextScaleIndex(index - 1)}
          style={{ color: index <= 0 ? 'var(--fg-muted)' : 'var(--fg)', fontSize: '0.95rem' }}
        >
          A<span aria-hidden="true">−</span>
        </button>
        <span className="sr-only-text" aria-live="polite">
          Text size {index + 1} of {TEXT_SCALES.length}
        </span>
        <button
          type="button"
          className="tap rounded-full px-3"
          aria-label="Larger text"
          disabled={index >= TEXT_SCALES.length - 1}
          onClick={() => setTextScaleIndex(index + 1)}
          style={{
            color: index >= TEXT_SCALES.length - 1 ? 'var(--fg-muted)' : 'var(--fg)',
            fontSize: '1.15rem',
          }}
        >
          A<span aria-hidden="true">+</span>
        </button>
      </div>

      <div data-chrome className="flex flex-wrap items-center gap-2">
        <ThemeToggle compact />
        {children}
      </div>
    </div>
  )
}
