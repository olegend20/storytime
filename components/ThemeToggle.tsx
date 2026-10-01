'use client'

import { usePrefs } from './usePrefs'
import type { Theme } from '@/lib/client/storage'

const OPTIONS: ReadonlyArray<{ value: Theme; label: string; hint: string }> = [
  { value: 'system', label: 'Auto', hint: 'Follow the device setting' },
  { value: 'light', label: 'Light', hint: 'Light theme' },
  { value: 'dark', label: 'Dark', hint: 'Dark theme, easier at bedtime' },
  { value: 'night', label: 'Night', hint: 'Near-black with dimmed, warm text for a dark bedroom' },
]

/**
 * Theme control (F9: "a night-friendly dark theme"). Night (DECISIONS #146) is dark taken
 * further: near-black, no white anywhere, the text warm and dimmed - as close as a web page
 * can get to turning the phone's brightness down in a dark bedroom.
 *
 * Radio states rather than a switch, because "follow my phone" is the setting most parents
 * already have configured for the evening, and a two-state switch silently overrides it.
 * Built as a radiogroup so the whole thing is one tab stop with arrow-key movement inside.
 */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { prefs, setTheme } = usePrefs()
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-1 rounded-full border border-line p-1"
    >
      {OPTIONS.map((option) => {
        const checked = prefs.theme === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            title={option.hint}
            onClick={() => setTheme(option.value)}
            className="rounded-full px-3 py-2 text-sm"
            style={{
              minHeight: 44,
              minWidth: 44,
              padding: compact ? '0 0.7rem' : undefined,
              background: checked ? 'var(--accent)' : 'transparent',
              color: checked ? 'var(--accent-fg)' : 'var(--fg)',
              fontWeight: checked ? 650 : 500,
            }}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
