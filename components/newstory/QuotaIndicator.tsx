'use client'

import type { QuotaResponse } from '@/lib/schemas'
import { useHydrated } from '@/lib/client/useHydrated'

/**
 * F10: the quota indicator, "2 of 3 stories left today". With balances switched on (issue
 * #128) it says what the family has left in all: "3 stories left".
 *
 * Phrased as what is left rather than what is used, because that is the question a parent is
 * asking, and because "1 of 3 used" invites the reading that two have gone.
 */
/** Mirrors UNLIMITED_DAILY_LIMIT in lib/limits/quota.ts; the `done` event carries only numbers. */
const UNLIMITED_AT = 1_000_000

export function isUnlimited(quota: QuotaResponse): boolean {
  return quota.unlimited === true || quota.limit >= UNLIMITED_AT
}

/** Issue #128: the family has a balance of stories, and it is empty. */
export function outOfStories(quota: QuotaResponse): boolean {
  return !isUnlimited(quota) && quota.credits !== undefined && quota.credits.balance <= 0
}

export function quotaMessage(quota: QuotaResponse): string {
  if (isUnlimited(quota)) {
    return `Unlimited stories (owner account) · ${quota.used} today`
  }
  // Issue #128: with a balance, an empty one comes first - no midnight refills it.
  if (outOfStories(quota)) return 'No stories left'
  const left = Math.max(0, quota.limit - quota.used)
  if (left === 0) return 'No stories left today'
  if (quota.credits) {
    const balance = quota.credits.balance
    return `${balance} ${balance === 1 ? 'story' : 'stories'} left`
  }
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
  const hydrated = useHydrated()
  if (!quota) return null
  const left = Math.max(0, quota.limit - quota.used)
  const empty = outOfStories(quota)
  const exhausted = (left === 0 && !isUnlimited(quota)) || empty
  // The server may render this (issue #17) and does not know the parent's clock or locale.
  const reset = hydrated ? resetTimeLabel(quota.resets_at) : null
  return (
    <p
      className="m-0 text-sm"
      style={{ color: exhausted ? 'var(--fg)' : 'var(--fg-muted)' }}
      // Announced when it changes, which is exactly when a story finishes.
      aria-live="polite"
    >
      <span style={{ fontWeight: exhausted ? 650 : 500 }}>{quotaMessage(quota)}</span>
      {exhausted && !empty && reset ? ` · next one unlocks at ${reset}` : ''}
      {!quota.generation_enabled ? ' · new stories are paused right now' : ''}
    </p>
  )
}
