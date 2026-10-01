'use client'

import { useState } from 'react'

/**
 * Send to Kindle (issue #11): the parent's Send-to-Kindle address, and the one thing Amazon
 * needs from them - our sending address on their approved list. Kept short: this is set
 * up once, at a desk, not at bedtime.
 */
export default function KindleSettingsForm({
  kindleEmail,
  fromAddress,
}: {
  kindleEmail: string | null
  /** Our sending address, or null when the server has no mail set up. */
  fromAddress: string | null
}) {
  const [address, setAddress] = useState(kindleEmail ?? '')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setStatus('saving')
    setError(null)
    let response: Response
    try {
      response = await fetch('/api/family', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kindle_email: address }),
      })
    } catch {
      // Wi-Fi dropped mid-tap: say so and let them try again, never a stuck button.
      setStatus('idle')
      setError('We could not reach StoryTime. Check the connection and try again.')
      return
    }
    if (!response.ok) {
      setStatus('idle')
      let message = 'We could not save that. Please try again.'
      try {
        message = ((await response.json()) as { message?: string }).message ?? message
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
    <form onSubmit={save} aria-labelledby="kindle-heading">
      <h2 id="kindle-heading" className="mt-0 mb-2 text-base font-semibold">
        Kindle
      </h2>
      <p className="mt-0 mb-3 text-[0.95rem]" style={{ color: 'var(--fg-muted)' }}>
        Read stories on a Kindle instead of a phone in the bedroom. Each saved story gets a
        <strong> Send to Kindle</strong> button.
      </p>
      {fromAddress ? (
        <ol className="mt-0 mb-4 list-decimal space-y-1.5 pl-5 text-[0.95rem]">
          <li>
            On Amazon, under <em>Manage Your Content and Devices → Preferences → Personal
            Document Settings</em>, add <code data-testid="kindle-from">{fromAddress}</code> to
            your approved e-mail list.
          </li>
          <li>Find your Kindle&rsquo;s Send-to-Kindle address on the same page and enter it below.</li>
        </ol>
      ) : (
        <p className="mt-0 mb-4 text-[0.95rem]" role="status">
          Send to Kindle is not set up on this server yet.
        </p>
      )}
      <label htmlFor="kindle-email" className="mb-1 block text-sm font-medium">
        Send-to-Kindle address
      </label>
      <input
        id="kindle-email"
        type="email"
        inputMode="email"
        autoComplete="off"
        className={inputClass}
        placeholder="yourname_abc123@kindle.com"
        value={address}
        onChange={(e) => {
          setAddress(e.target.value)
          setStatus('idle')
        }}
        maxLength={80}
      />
      {error && (
        <p role="alert" className="mt-2 mb-0 text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" className="btn" disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save Kindle address'}
        </button>
        {status === 'saved' && (
          <span role="status" className="text-sm">
            Saved.
          </span>
        )}
      </div>
    </form>
  )
}
