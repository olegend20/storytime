'use client'

import type { ErrorBody } from '@/lib/schemas'
import { FREE_RETRY_NOTE, needsFreeRetryNote } from '@/lib/client/generate'
import { resetTimeLabel } from './QuotaIndicator'

/**
 * Every failure a parent can see, in one place (F10: "friendly error states").
 *
 * Three rules this component exists to keep:
 *  1. `error.message` is rendered VERBATIM. Parent-facing refusal copy comes from
 *     `config/guardrails/messages.json` (lane 6) and arrives in the `error` event. The UI does
 *     not rewrite it, soften it or add to it.
 *  2. The parent's rejected input is never echoed back, and the code is never shown - nothing
 *     here reveals which safety layer fired (`GUARDRAILS.md` §5).
 *  3. When `quota_consumed` is false the parent is told so, because being wrongly told you have
 *     lost one of three nightly stories is the worst small failure this product has.
 */
export function GenerationError({
  error,
  onRetry,
  retryLabel = 'Try again',
}: {
  error: ErrorBody
  onRetry?: () => void
  retryLabel?: string
}) {
  const reset = resetTimeLabel(error.resets_at)
  const showFreeNote = needsFreeRetryNote(error)
  const canRetry = onRetry && error.code !== 'quota_exceeded'

  return (
    <div
      role="alert"
      className="card p-4"
      style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
    >
      {/* Verbatim, from the server. */}
      <p className="mt-0 mb-0">{error.message}</p>

      {reset && (
        <p className="mt-2 mb-0 text-sm" style={{ color: 'var(--fg-muted)' }}>
          Your next story unlocks at {reset}.
        </p>
      )}

      {showFreeNote && (
        <p className="mt-2 mb-0 text-sm" style={{ fontWeight: 600 }}>
          {FREE_RETRY_NOTE}
        </p>
      )}

      {canRetry && (
        <button type="button" className="btn btn-quiet mt-3" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  )
}
