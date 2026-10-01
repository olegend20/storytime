'use client'

import Link from 'next/link'
import { useState } from 'react'
import { sendToKindle, ApiError } from '@/lib/client/api'

/**
 * Send to Kindle (issue #11). One tap; the story arrives on the Kindle in a few minutes.
 * Failure copy is specific: no address yet links to Settings; a provider problem says
 * nothing was changed.
 */
export function SendToKindleButton({ storyId }: { storyId: string }) {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; to: string } | { kind: 'error'; code: string; message: string }
  >({ kind: 'idle' })

  async function send() {
    setState({ kind: 'sending' })
    try {
      const result = await sendToKindle(storyId)
      setState({ kind: 'sent', to: result.sent.to })
    } catch (err) {
      if (err instanceof ApiError) setState({ kind: 'error', code: err.code ?? 'error', message: err.serverMessage ?? 'We could not send that story.' })
      else setState({ kind: 'error', code: 'error', message: 'We could not send that story. Please try again.' })
    }
  }

  if (state.kind === 'sent') {
    return (
      <p role="status" className="m-0 text-sm" data-testid="kindle-sent">
        Sent to <strong>{state.to}</strong>. It usually arrives on the Kindle within a few minutes.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-quiet" onClick={send} disabled={state.kind === 'sending'} data-testid="send-to-kindle">
        {state.kind === 'sending' ? 'Sending…' : 'Send to Kindle'}
      </button>
      {state.kind === 'error' && (
        <span role="alert" className="text-sm" data-testid="kindle-error">
          {state.message}{' '}
          {state.code === 'no_kindle_address' && (
            <Link href="/settings" className="underline">
              Add it in Settings
            </Link>
          )}
        </span>
      )}
    </div>
  )
}
