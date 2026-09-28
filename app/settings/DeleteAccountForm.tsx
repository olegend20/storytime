'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * F2: account deletion. Hard delete, no undo, so the parent types the word first.
 *
 * On success we leave for the landing page and `router.refresh()` immediately: the session
 * cookie is gone, so every cached Server Component render belongs to an account that no
 * longer exists and has to be thrown away.
 */

const CONFIRM_WORD = 'delete'

export default function DeleteAccountForm() {
  const router = useRouter()
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = confirmation.trim().toLocaleLowerCase() === CONFIRM_WORD

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    const response = await fetch('/api/account', { method: 'DELETE' })
    if (!response.ok) {
      setBusy(false)
      let message = 'We could not delete the account. Please try again.'
      try {
        const body = (await response.json()) as { message?: string }
        message = body.message ?? message
      } catch {
        /* keep the fallback */
      }
      setError(message)
      return
    }
    router.replace('/?deleted=1')
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="m-0 text-[0.95rem] leading-relaxed">
        This removes your children&apos;s profiles, your series, your story bibles and every
        story, in one go. It cannot be undone. We keep only the anonymous accounting rows that
        record what each story cost to generate — no names, no topics, no story text.
      </p>
      <label htmlFor="confirm-delete" className="block text-sm font-medium">
        Type <strong>{CONFIRM_WORD}</strong> to confirm
      </label>
      <input
        id="confirm-delete"
        value={confirmation}
        onChange={(e) => setConfirmation(e.target.value)}
        autoComplete="off"
        className="w-full max-w-xs rounded-lg border border-black/15 bg-white px-3 py-2 text-base dark:border-white/20 dark:bg-white/5"
      />
      {error ? (
        <p role="alert" className="m-0 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!ready || busy}
        className="rounded-lg border border-red-700/40 px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50 dark:border-red-400/40 dark:text-red-400"
      >
        {busy ? 'Deleting…' : 'Delete account'}
      </button>
    </form>
  )
}
