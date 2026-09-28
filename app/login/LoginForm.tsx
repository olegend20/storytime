'use client'

import { useState } from 'react'
import { supabaseBrowser } from '@/lib/supabase/client'
import { detectTimeZone } from '@/lib/family/timezone'

/**
 * F2: email magic link, plus Google OAuth when the provider is configured.
 *
 * Google is wired up but disabled by default: `supabase/config.toml` ships
 * `[auth.external.google] enabled = false`, so enabling it is a config change (provider
 * credentials + `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED=true`), not a code change.
 */

const GOOGLE_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED === 'true'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle')
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
    const { error: sendError } = await supabaseBrowser().auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: callbackUrl() },
    })
    if (sendError) {
      setStatus('idle')
      setError('We could not send that link just now. Please try again in a moment.')
      return
    }
    setStatus('sent')
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

  if (status === 'sent') {
    return (
      <div className="rounded-xl border border-black/10 bg-black/[0.02] p-5 dark:border-white/15 dark:bg-white/[0.04]">
        <h2 className="m-0 text-lg font-semibold">Check your email</h2>
        <p className="mt-2 mb-0 text-sm leading-relaxed opacity-80">
          We sent a sign-in link to <strong>{email.trim()}</strong>. It opens StoryTime on this
          device and expires shortly.
        </p>
        <button
          type="button"
          onClick={() => setStatus('idle')}
          className="mt-4 text-sm underline underline-offset-2 opacity-70 hover:opacity-100"
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
          className="mt-1.5 w-full rounded-lg border border-black/15 bg-white px-3 py-2.5 text-base dark:border-white/20 dark:bg-white/5"
        />
        <button
          type="submit"
          disabled={status === 'sending'}
          className="mt-3 w-full rounded-lg bg-ink px-4 py-2.5 text-base font-medium text-paper disabled:opacity-60 dark:bg-paper dark:text-ink"
        >
          {status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
        </button>
      </form>

      <div className="mt-6 border-t border-black/10 pt-5 dark:border-white/15">
        {GOOGLE_ENABLED ? (
          <button
            type="button"
            onClick={signInWithGoogle}
            className="w-full rounded-lg border border-black/15 px-4 py-2.5 text-base font-medium dark:border-white/20"
          >
            Continue with Google
          </button>
        ) : (
          <p className="m-0 text-sm opacity-60">
            Google sign-in is not enabled on this deployment.
          </p>
        )}
      </div>

      {error ? (
        <p role="alert" className="mt-4 mb-0 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}

      <p className="mt-6 mb-0 text-xs leading-relaxed opacity-60">
        No password to remember. We only store your email address and your children&apos;s first
        names — see our <a href="/privacy" className="underline underline-offset-2">privacy page</a>.
      </p>
    </div>
  )
}
