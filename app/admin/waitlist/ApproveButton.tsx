'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

/** Issue #92: approve one address (or resend an invite that never went), then refresh the list. */
export default function ApproveButton({ email, label }: { email: string; label: string }) {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle')
  const [note, setNote] = useState<string | null>(null)

  async function approve() {
    setState('busy')
    setNote(null)
    try {
      const response = await fetch('/api/admin/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = (await response.json().catch(() => null)) as { approved?: boolean; emailed?: boolean } | null
      if (!response.ok || !body?.approved) throw new Error(String(response.status))
      setNote(body.emailed ? 'Approved · invite sent' : 'Approved · no email sent')
      setState('idle')
      router.refresh()
    } catch {
      setState('error')
      setNote('Failed - try again')
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {note ? (
        <span role="status" className="text-xs opacity-70">
          {note}
        </span>
      ) : null}
      <button
        type="button"
        onClick={approve}
        disabled={state === 'busy'}
        aria-label={`${label}: ${email}`}
        className="rounded border border-black/20 px-3 py-1 text-xs font-medium hover:bg-black/5 disabled:opacity-50 dark:border-white/25 dark:hover:bg-white/10"
      >
        {state === 'busy' ? 'Working…' : label}
      </button>
    </span>
  )
}
