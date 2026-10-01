'use client'

import Link from 'next/link'
import { ChevronLeft, More } from '@/components/Icons'
import { Menu } from '@/components/Menu'
import { Phase } from '@/components/Phase'
import { usePrefs } from '@/components/usePrefs'
import { ThemeToggle } from '@/components/ThemeToggle'
import { TEXT_SCALES } from '@/lib/client/storage'

/**
 * The reader's own controls (issue #17): back to the library, read together, text size, theme,
 * and the story's actions.
 *
 * "Read together" (reading mode) and text size stay visible in reading mode - they are how you
 * get back out and how you fix the size once you are in. Everything else is chrome and
 * disappears. Theme and the story actions sit behind small menus so the bar stays one quiet
 * line on a phone.
 */
export function ReaderControls({ children }: { children?: React.ReactNode }) {
  const { prefs, setReadingMode, setTextScaleIndex } = usePrefs()
  const index = prefs.textScaleIndex

  return (
    <div className="st-rbar">
      <Link href="/library" data-chrome className="st-rbtn" aria-label="Back to the library">
        <ChevronLeft width={16} height={16} />
        <span>Library</span>
      </Link>

      <div className="st-rbar-right">
        <button type="button" className="st-rbtn" onClick={() => setReadingMode(!prefs.readingMode)}>
          <span data-when-reading="off">Read together</span>
          <span data-when-reading="on">Done reading</span>
        </button>

        <div role="group" aria-label="Text size" className="st-rsize">
          <button
            type="button"
            className="st-rbtn st-rbtn-sq"
            aria-label="Smaller text"
            disabled={index <= 0}
            onClick={() => setTextScaleIndex(index - 1)}
          >
            <span aria-hidden="true" className="st-a-sm">
              A
            </span>
          </button>
          <span className="sr-only-text" aria-live="polite">
            Text size {index + 1} of {TEXT_SCALES.length}
          </span>
          <button
            type="button"
            className="st-rbtn st-rbtn-sq"
            aria-label="Larger text"
            disabled={index >= TEXT_SCALES.length - 1}
            onClick={() => setTextScaleIndex(index + 1)}
          >
            <span aria-hidden="true" className="st-a-lg">
              A
            </span>
          </button>
        </div>

        <div data-chrome className="st-rbar-menus">
          <Menu label="Theme" icon={<Phase lit={0.3} size={18} />} testId="theme-menu">
            <ThemeToggle />
          </Menu>
          {children ? (
            <Menu label="Story actions" icon={<More />} testId="story-actions">
              <div className="st-menu-actions">{children}</div>
            </Menu>
          ) : null}
        </div>
      </div>
    </div>
  )
}
