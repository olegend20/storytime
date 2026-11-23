'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
import { sendToKindle, ApiError } from '@/lib/client/api'
import { KINDLE_HELP_PATH } from '@/lib/kindle/help'

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

export function SendToKindleButton({
  state,
  onSend,
  testId = 'send-to-kindle',
}: {
  state: KindleState
  onSend: () => void
  /** The menu's button keeps the default; the one at the end of the story is `send-to-kindle-end` (issue #119). */
  testId?: string
}) {
  return (
    <button type="button" className="btn btn-quiet" onClick={onSend} disabled={state.kind === 'sending'} data-testid={testId}>
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
        {' '}
        <Link href={KINDLE_HELP_PATH} className="underline" style={{ color: 'inherit' }}>
          Not there?
        </Link>
      </p>
    )
  }
  return (
    <p role="alert" className="st-rnotice" data-testid="kindle-error">
      {state.message}{' '}
      {state.code === 'no_kindle_address' && (
        <>
          <Link href="/settings" className="underline" style={{ color: 'inherit' }}>
            Add it in Settings
          </Link>
          , or see{' '}
          <Link href={KINDLE_HELP_PATH} className="underline" style={{ color: 'inherit' }}>
            how to set it up
          </Link>
          .
        </>
      )}
    </p>
  )
}
