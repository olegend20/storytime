'use client'

import { useMemo, useState } from 'react'
import { FIELD_MAX_LENGTH } from '@/lib/http/sanitize'
import { detectTimeZone } from '@/lib/family/timezone'

/**
 * F2: display name and timezone.
 *
 * The timezone is auto-detected and editable (F2 scope). Detection happens in the browser
 * because that is the only place that knows; the server validates that whatever arrives is
 * a real IANA zone name, since F8 draws the quota day boundary from it.
 */
export default function FamilySettingsForm({
  family,
  timezones,
}: {
  family: { display_name: string; timezone: string }
  timezones: string[]
}) {
  const [displayName, setDisplayName] = useState(family.display_name)
  const [timezone, setTimezone] = useState(family.timezone)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)

  const detected = useMemo(() => detectTimeZone(), [])
  const options = useMemo(() => {
    const set = new Set(timezones)
    set.add(family.timezone)
    set.add(detected)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [timezones, family.timezone, detected])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setStatus('saving')
    setError(null)
    const response = await fetch('/api/family', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: displayName, timezone }),
    })
    if (!response.ok) {
      setStatus('idle')
      let message = 'We could not save that. Please try again.'
      try {
        const body = (await response.json()) as { message?: string }
        message = body.message ?? message
      } catch {
        /* keep the fallback */
      }
      setError(message)
      return
    }
    setStatus('saved')
  }

  const inputClass =
    'w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-base dark:border-white/20 dark:bg-white/5'

  return (
    <form onSubmit={save} className="space-y-4">
      <div>
        <label htmlFor="display_name" className="block text-sm font-medium">
          Family name
        </label>
        <input
          id="display_name"
          name="display_name"
          value={displayName}
          maxLength={FIELD_MAX_LENGTH.display_name}
          onChange={(e) => {
            setDisplayName(e.target.value)
            setStatus('idle')
          }}
          className={`mt-1.5 ${inputClass}`}
          required
        />
      </div>

      <div>
        <label htmlFor="timezone" className="block text-sm font-medium">
          Timezone
        </label>
        <select
          id="timezone"
          name="timezone"
          value={timezone}
          onChange={(e) => {
            setTimezone(e.target.value)
            setStatus('idle')
          }}
          className={`mt-1.5 ${inputClass}`}
        >
          {options.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        <p className="mt-1 mb-0 text-xs opacity-60">
          Your nightly story allowance resets at midnight here.{' '}
          {detected !== timezone ? (
            <>
              This device says <strong>{detected.replace(/_/g, ' ')}</strong>.{' '}
              <button
                type="button"
                onClick={() => {
                  setTimezone(detected)
                  setStatus('idle')
                }}
                className="underline underline-offset-2"
              >
                Use that
              </button>
            </>
          ) : (
            <>Detected from this device.</>
          )}
        </p>
      </div>

      {error ? (
        <p role="alert" className="m-0 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={status === 'saving'}
          className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-60 dark:bg-paper dark:text-ink"
        >
          {status === 'saving' ? 'Saving…' : 'Save settings'}
        </button>
        {status === 'saved' ? (
          <span role="status" className="text-sm opacity-70">
            Saved.
          </span>
        ) : null}
      </div>
    </form>
  )
}
