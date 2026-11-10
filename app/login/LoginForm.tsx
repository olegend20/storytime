'use client'

import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase/client'
import { detectTimeZone } from '@/lib/family/timezone'
import { COMING_SOON } from '@/lib/landing/copy'
import { normalizeEmail } from '@/lib/waitlist/email'

/**
 * F2: email magic link, plus Google OAuth when the provider is configured.
 *
 * Issue #92: Supabase's own sign-up is off, so the link below only reaches an existing
 * account. When Supabase finds none, `POST /api/auth/prepare` creates it if the address may
 * have one (approved, or the waitlist is off) and the link is asked for once more. Every
 * address then sees the same "Check your email" - the page never says who has an account or
 * a place - and, while the waitlist is on, how to join it if no email comes.
 *
 * Google is wired up but disabled by default: `supabase/config.toml` ships
 * `[auth.external.google] enabled = false`, so enabling it is a config change (provider
 * credentials + `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true`), not a code change.
 */

const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === 'true'

/** What Supabase says when the address has no account and sign-up is closed. */
const NO_ACCOUNT_CODES = new Set(['otp_disabled', 'signup_disabled', 'user_not_found'])

export default function LoginForm({
  next,
  initialError,
  initialEmail = '',
  waitlist = false,
}: {
  next: string
  initialError?: string
  /** From the invite email's link (`/login?email=`), so the parent only has to press send. */
  initialEmail?: string
  /** Places open a few at a time: "Check your email" also says how to join the waitlist. */
  waitlist?: boolean
}) {
  const [email, setEmail] = useState(initialEmail)
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'joined'>('idle')
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
    const address = normalizeEmail(email)
    if (!address) {
      setError('Please enter an email address we can send the link to.')
      return
    }
    setError(null)
    setStatus('sending')
    rememberTimezone()

    const requestLink = () =>
      supabaseBrowser().auth.signInWithOtp({
        email: address,
        options: { shouldCreateUser: false, emailRedirectTo: callbackUrl() },
      })
    const couldNotSend = () => {
      setStatus('idle')
      setError('We could not send that link just now. Please try again in a moment.')
    }

    let { error: sendError } = await requestLink()
    if (sendError && NO_ACCOUNT_CODES.has(sendError.code ?? '')) {
      try {
        const prepared = await fetch('/api/auth/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: address }),
        })
        if (!prepared.ok) return couldNotSend()
      } catch {
        return couldNotSend()
      }
      ;({ error: sendError } = await requestLink())
    }
    // Still no account means no place yet. That looks exactly like a link on its way: the
    // page must not tell a stranger who has an account.
    if (sendError && !NO_ACCOUNT_CODES.has(sendError.code ?? '')) {
      if (sendError.status === 429) {
        setStatus('idle')
        setError('Too many links asked for just now. Please wait a minute and try again.')
        return
      }
      return couldNotSend()
    }
    setStatus('sent')
  }

  async function joinWaitlist() {
    setError(null)
    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: normalizeEmail(email) }),
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

  if (status === 'joined') {
    return (
      <div className="card p-5">
        {/* Issue #95: joining sends a confirmation link; the address is on the list once confirmed. */}
        <h2 className="m-0 text-2xl font-normal">{COMING_SOON.joinedTitle}</h2>
        <p className="mt-2 mb-0 text-sm leading-relaxed text-muted">
          We have sent a link to <strong>{email.trim()}</strong> to confirm your place. If it is not in
          your inbox, look in spam.
        </p>
        <button type="button" onClick={() => setStatus('idle')} className="st-textlink mt-2">
          Use a different email
        </button>
      </div>
    )
  }

  if (status === 'sent') {
    return (
      <div className="card p-5">
        <h2 className="m-0 text-2xl font-normal">Check your email</h2>
        {waitlist ? (
          <>
            <p className="mt-2 mb-0 text-sm leading-relaxed text-muted">
              If <strong>{email.trim()}</strong> has a place, a sign-in link is on its way. It
              opens StoryTime on this device and expires shortly.
            </p>
            <p className="mt-3 mb-0 text-sm leading-relaxed text-muted">
              No email in a few minutes? We are opening places a few families at a time, so you
              may not have one yet.
            </p>
            <button type="button" onClick={joinWaitlist} className="btn btn-quiet mt-3 w-full">
              Join the waitlist
            </button>
          </>
        ) : (
          <p className="mt-2 mb-0 text-sm leading-relaxed text-muted">
            We sent a sign-in link to <strong>{email.trim()}</strong>. It opens StoryTime on this
            device and expires shortly.
          </p>
        )}
        <button
          type="button"
          onClick={() => setStatus('idle')}
          className="st-textlink mt-2"
        >
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
