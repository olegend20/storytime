'use client'

import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase/client'
import { detectTimeZone } from '@/lib/family/timezone'

/**
 * F2: email magic link, plus Google OAuth when the provider is configured.
 *
 * Issue #92: the link is asked of our own server (`POST /api/auth/email`), which is the only
 * thing allowed to create an account - only for an approved address while the waitlist is
 * on. An address that is not approved yet is offered the waitlist right here.
 *
 * Google is wired up but disabled by default: `supabase/config.toml` ships
 * `[auth.external.google] enabled = false`, so enabling it is a config change (provider
 * credentials + `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true`), not a code change.
 */

const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === 'true'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function LoginForm({
  next,
  initialError,
  initialEmail = '',
}: {
  next: string
  initialError?: string
  /** From the invite email's link (`/login?email=`), so the parent only has to press send. */
  initialEmail?: string
}) {
  const [email, setEmail] = useState(initialEmail)
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'not_approved' | 'joined'>('idle')
  const [error, setError] = useState<string | null>(initialError ?? null)

  const callbackUrl = () => {
    const url = new URL('/auth/callback', window.location.origin)
    if (next) url.searchParams.set('next', next)
    return url.toString()
  }

  /**
   * Remember the browser's timezone for the callback, so a family created by following
   * the link gets a real quota day boundary rather than UTC (F8). Short-lived and
   * SameSite=Lax; it carries no personal data.
   */
  const rememberTimezone = () => {
    try {
      document.cookie = `st_tz=${encodeURIComponent(detectTimeZone())}; path=/; max-age=1800; samesite=lax`
    } catch {
      /* cookies disabled: the family just starts on UTC and can change it in settings */
    }
  }

  async function sendMagicLink(event: React.FormEvent) {
    event.preventDefault()
    const address = email.trim()
    if (!EMAIL_SHAPE.test(address)) {
      setError('Please enter an email address we can send the link to.')
      return
    }
    setError(null)
    setStatus('sending')
    rememberTimezone()
    try {
      const response = await fetch('/api/auth/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: address, next }),
      })
      const body = (await response.json().catch(() => null)) as { status?: string; message?: string } | null
      if (response.ok && body?.status === 'not_approved') {
        setStatus('not_approved')
        return
      }
      if (!response.ok || body?.status !== 'sent') {
        setStatus('idle')
        setError(
          response.status === 429 && body?.message
            ? body.message
            : 'We could not send that link just now. Please try again in a moment.',
        )
        return
      }
      setStatus('sent')
    } catch {
      setStatus('idle')
      setError('We could not send that link just now. Please try again in a moment.')
    }
  }

  async function joinWaitlist() {
    setError(null)
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!response.ok) throw new Error(String(response.status))
      setStatus('joined')
    } catch {
      setError('We could not add you just now. Please try again in a moment.')
    }
  }

  async function signInWithGoogle() {
    setError(null)
    rememberTimezone()
    const { error: oauthError } = await supabaseBrowser().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callbackUrl() },
    })
    if (oauthError) setError('Google sign-in is not available right now.')
  }

  if (status === 'not_approved' || status === 'joined') {
    return (
      <div className="card p-5">
        {status === 'joined' ? (
          <>
            <h2 className="m-0 text-2xl font-normal">You&rsquo;re on the list</h2>
            <p className="mt-2 mb-0 text-sm leading-relaxed text-muted">
              We&rsquo;ll email <strong>{email.trim()}</strong> when your place is ready.
            </p>
          </>
        ) : (
          <>
            <h2 className="m-0 text-2xl font-normal">Your place isn&rsquo;t ready yet</h2>
            <p className="mt-2 mb-0 text-sm leading-relaxed text-muted">
              We are opening places a few families at a time, and{' '}
              <strong>{email.trim()}</strong> doesn&rsquo;t have one yet. Join the waitlist and
              we&rsquo;ll email you when it&rsquo;s ready.
            </p>
            <button type="button" onClick={joinWaitlist} className="btn mt-4 w-full">
              Join the waitlist
            </button>
          </>
        )}
        <button type="button" onClick={() => setStatus('idle')} className="st-textlink mt-2">
          Use a different email
        </button>
        {error ? (
          <p role="alert" className="mt-3 mb-0 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  if (status === 'sent') {
    return (
      <div className="card p-5">
        <h2 className="m-0 text-2xl font-normal">Check your email</h2>
        <p className="mt-2 mb-0 text-sm leading-relaxed text-muted">
          We sent a sign-in link to <strong>{email.trim()}</strong>. It opens StoryTime on this
          device and expires shortly.
        </p>
        <button
          type="button"
          onClick={() => setStatus('idle')}
          className="st-textlink mt-2"
        >
          Use a different email
        </button>
      </div>
    )
  }

  return (
    <div>
      <form onSubmit={sendMagicLink} noValidate>
        <label htmlFor="email" className="block text-sm font-medium">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="field mt-1.5"
        />
        <button
          type="submit"
          disabled={status === 'sending'}
          className="btn mt-3 w-full"
        >
          {status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
        </button>
      </form>

      <div className="mt-6 border-t border-line pt-5">
        {GOOGLE_ENABLED ? (
          <button
            type="button"
            onClick={signInWithGoogle}
            className="btn btn-quiet w-full"
          >
            Continue with Google
          </button>
        ) : (
          <p className="m-0 text-sm text-muted">
            Google sign-in is not enabled on this deployment.
          </p>
        )}
      </div>

      {error ? (
        <p role="alert" className="mt-4 mb-0 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <p className="mt-6 mb-0 text-[0.8125rem] leading-relaxed text-muted">
        No password to remember. We only store your email address and your children&apos;s first
        names — see our <a href="/privacy" className="underline underline-offset-2" style={{ color: 'inherit' }}>privacy page</a>.
      </p>
    </div>
  )
}
