'use client'

import { useState } from 'react'
import { ArrowRight } from '@/components/Icons'
import { COMING_SOON } from '@/lib/landing/copy'
import { normalizeEmail } from '@/lib/waitlist/email'

/**
 * Issue #92: the coming-soon page's one action. Posts to /api/waitlist and swaps itself for
 * a thank-you. The server answers the same for a new address and a known one, so this does
 * too.
 *
 * `website` is the honeypot the route ignores: hidden from people and from screen readers,
 * left empty by anyone who is not a form-filling bot.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'joined'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function join(event: React.FormEvent) {
    event.preventDefault()
    const address = normalizeEmail(email)
    if (!address) {
      setError(COMING_SOON.badEmail)
      return
    }
    setError(null)
    setStatus('sending')
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, website }),
      })
      if (!response.ok) throw new Error(String(response.status))
      setStatus('joined')
    } catch {
      setStatus('idle')
      setError(COMING_SOON.joinError)
    }
  }

  if (status === 'joined') {
    return (
      <div className="lt-joined" role="status">
        <p className="lt-joined-title">{COMING_SOON.joinedTitle}</p>
        <p className="lt-joined-body">{COMING_SOON.joinedBody}</p>
      </div>
    )
  }

  return (
    <form className="lt-join" onSubmit={join} noValidate>
      <label htmlFor="join-email" className="sr-only-text">
        {COMING_SOON.joinLabel}
      </label>
      <div className="lt-join-row">
        <input
          id="join-email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="field lt-join-field"
          aria-invalid={error === COMING_SOON.badEmail ? true : undefined}
          aria-describedby={error ? 'join-error' : undefined}
        />
        <button type="submit" className="st-primary lt-primary" disabled={status === 'sending'}>
          {status === 'sending' ? COMING_SOON.joining : COMING_SOON.joinButton} <ArrowRight />
        </button>
      </div>
      <div className="lt-hp" aria-hidden="true">
        <label htmlFor="join-website">Website</label>
        <input
          id="join-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>
      {error ? (
        <p id="join-error" role="alert" className="lt-join-error">
          {error}
        </p>
      ) : null}
    </form>
  )
}
