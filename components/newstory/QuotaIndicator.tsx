'use client'

import type { QuotaResponse } from '@/lib/schemas'

/**
 * F10: the quota indicator, "2 of 3 stories left today".
 *
 * Phrased as what is left rather than what is used, because that is the question a parent is
 * asking, and because "1 of 3 used" invites the reading that two have gone.
 */
export function quotaMessage(quota: QuotaResponse): string {
  const left = Math.max(0, quota.limit - quota.used)
  if (left === 0) return 'No stories left today'
  // The noun agrees with the LIMIT, not with what is left: "1 of 3 stories left today", never
  // "1 of 3 story left today". F10's AC quotes the phrasing as "2 of 3 stories left today".
  return `${left} of ${quota.limit} ${quota.limit === 1 ? 'story' : 'stories'} left today`
}

export function resetTimeLabel(isoOrNull: string | null | undefined): string | null {
  if (!isoOrNull) return null
  const at = new Date(isoOrNull)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function QuotaIndicator({ quota }: { quota: QuotaResponse | null }) {
  if (!quota) return null
  const left = Math.max(0, quota.limit - quota.used)
  const exhausted = left === 0
  const reset = resetTimeLabel(quota.resets_at)
  return (
    <p
      className="m-0 text-sm"
      style={{ color: exhausted ? 'var(--fg)' : 'var(--fg-muted)' }}
      // Announced when it changes, which is exactly when a story finishes.
      aria-live="polite"
    >
      <span style={{ fontWeight: exhausted ? 650 : 500 }}>{quotaMessage(quota)}</span>
      {exhausted && reset ? ` · next one unlocks at ${reset}` : ''}
      {!quota.generation_enabled ? ' · new stories are paused right now' : ''}
    </p>
  )
}
