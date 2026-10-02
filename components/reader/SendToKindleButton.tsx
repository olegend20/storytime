'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
import { sendToKindle, ApiError } from '@/lib/client/api'

/**
 * Send to Kindle (issue #11). One tap; the story arrives on the Kindle in a few minutes.
 * Failure copy is specific: no address yet links to Settings; a provider problem says
 * nothing was changed.
 *
 * In two parts since the reader's actions moved into a menu (issue #17): the button lives in
 * the menu, and the outcome is shown on the page itself, where it stays visible - and is
 * announced - after the menu has closed.
 */
export type KindleState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; to: string }
  | { kind: 'error'; code: string; message: string }

export function useSendToKindle(storyId: string): { state: KindleState; send: () => Promise<void> } {
  const [state, setState] = useState<KindleState>({ kind: 'idle' })
  const send = useCallback(async () => {
    setState({ kind: 'sending' })
    try {
      const result = await sendToKindle(storyId)
      setState({ kind: 'sent', to: result.sent.to })
    } catch (err) {
      if (err instanceof ApiError) setState({ kind: 'error', code: err.code ?? 'error', message: err.serverMessage ?? 'We could not send that story.' })
      else setState({ kind: 'error', code: 'error', message: 'We could not send that story. Please try again.' })
    }
  }, [storyId])
  return { state, send }
}

export function SendToKindleButton({ state, onSend }: { state: KindleState; onSend: () => void }) {
  return (
    <button type="button" className="btn btn-quiet" onClick={onSend} disabled={state.kind === 'sending'} data-testid="send-to-kindle">
      {state.kind === 'sending' ? 'Sending…' : 'Send to Kindle'}
    </button>
  )
}

/** What happened to the send. Rendered outside the menu; nothing while idle. */
export function KindleStatus({ state }: { state: KindleState }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'sending') {
    return (
      <p role="status" className="st-rnotice">
        Sending to your Kindle…
      </p>
    )
  }
  if (state.kind === 'sent') {
    return (
      <p role="status" className="st-rnotice" data-testid="kindle-sent">
        Sent to <strong>{state.to}</strong>. It usually arrives on the Kindle within a few minutes.
      </p>
    )
  }
  return (
    <p role="alert" className="st-rnotice" data-testid="kindle-error">
      {state.message}{' '}
      {state.code === 'no_kindle_address' && (
        <Link href="/settings" className="underline" style={{ color: 'inherit' }}>
          Add it in Settings
        </Link>
      )}
    </p>
  )
}
