'use client'

import Link from 'next/link'
import { useState } from 'react'
import { ArrowRight } from '@/components/Icons'
import { COMING_SOON } from '@/lib/landing/copy'

const copy = COMING_SOON.confirm

/** Issue #95: one press confirms the address; the answer replaces the button. */
export default function ConfirmButton({ token }: { token: string | null }) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'bad'>(token ? 'idle' : 'bad')
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setError(null)
    setStatus('sending')
    try {
      const response = await fetch('/api/waitlist/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (response.ok) return setStatus('done')
      if (response.status === 400) return setStatus('bad')
      throw new Error(String(response.status))
    } catch {
      setStatus('idle')
      setError(copy.error)
    }
  }

  if (status === 'done') {
    return (
      <>
        <h1 className="lt-h1">{copy.doneTitle}</h1>
        <p className="lt-lead" role="status">
          {copy.doneBody}
        </p>
      </>
    )
  }

  if (status === 'bad') {
    return (
      <>
        <h1 className="lt-h1">{copy.badTitle}</h1>
        <p className="lt-lead">{copy.badBody}</p>
        <div className="lt-cta">
          <Link href="/#join" className="st-primary lt-primary">
            {copy.again} <ArrowRight />
          </Link>
        </div>
      </>
    )
  }

  return (
    <>
      <h1 className="lt-h1">{copy.title}</h1>
      <p className="lt-lead">{copy.body}</p>
      <div className="lt-cta">
        <button type="button" className="st-primary lt-primary" onClick={confirm} disabled={status === 'sending'}>
          {status === 'sending' ? copy.confirming : copy.button} <ArrowRight />
        </button>
      </div>
      {error ? (
        <p role="alert" className="lt-join-error">
          {error}
        </p>
      ) : null}
    </>
  )
}
