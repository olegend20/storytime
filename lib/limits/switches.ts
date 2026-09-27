/**
 * F8 AC: "Kill switch and budget cap take effect without a deploy."
 *
 * Both are read from `process.env` on EVERY call rather than from the cached `serverEnv()`
 * snapshot, so flipping the variable in the hosting platform (or in a running process)
 * changes behaviour at the next request with no rebuild and no module reload. See
 * DECISIONS.md for the caveat: on Vercel an env-var change still needs a redeploy to be
 * injected into the running lambda, so the switch is only as live as the platform makes it.
 */

/** Default: 3 stories per family per calendar day (§0, `DAILY_STORY_LIMIT` in the contract). */
export { DAILY_STORY_LIMIT } from '@/lib/schemas/api'

const DEFAULT_DAILY_BUDGET_USD = 5

/** Accepts the shell-ish spellings, matching lib/env.ts's `Booleanish`. */
function booleanish(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  const v = raw.trim().toLowerCase()
  if (v === '') return fallback
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  console.warn(`[limits] GENERATION_ENABLED=${JSON.stringify(raw)} is not a boolean; using ${fallback}`)
  return fallback
}

/**
 * The global kill switch. Fails SAFE — an unparseable value leaves generation on, because
 * a typo in an env var must not take the product down silently; an operator turning it off
 * will set a value that parses.
 */
export function generationEnabled(): boolean {
  return booleanish(process.env.GENERATION_ENABLED, true)
}

/** The global daily spend cap in USD. Not per family — this bounds the owner's bill. */
export function dailyBudgetUsd(): number {
  const raw = process.env.DAILY_BUDGET_USD
  if (raw === undefined || raw.trim() === '') return DEFAULT_DAILY_BUDGET_USD
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[limits] DAILY_BUDGET_USD=${JSON.stringify(raw)} is not a positive number; ` +
        `using $${DEFAULT_DAILY_BUDGET_USD}`,
    )
    return DEFAULT_DAILY_BUDGET_USD
  }
  return parsed
}
