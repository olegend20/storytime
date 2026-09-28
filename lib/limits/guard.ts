import type { SupabaseClient } from '@supabase/supabase-js'
import { ErrorBody, HTTP_STATUS_FOR_ERROR } from '@/lib/schemas/api'
import { budgetStatus, type BudgetStatus } from '@/lib/costs/budget'
import { LIMIT_MESSAGES } from './messages'
import { quotaStatus, type QuotaSnapshot } from './quota'
import { generationEnabled } from './switches'

/**
 * The F8 gate every generation request passes through before any model call.
 *
 * Lane 2's `/api/stories/generate` calls this first. It costs one cheap read each of
 * `v_budget_today` and `daily_usage` and it consumes nothing: quota is claimed later with
 * `consumeQuota()`, only once a `stories` row is committed, so refusals and failures are
 * free (F8 AC).
 *
 * Order is deliberate — cheapest and most global first:
 *   1. `GENERATION_ENABLED=false` → 503 service_paused (no DB read at all)
 *   2. today's spend ≥ `DAILY_BUDGET_USD` → 503 budget_exceeded
 *   3. family at the daily story limit → 429 quota_exceeded, with the local reset time
 */

export interface PreflightArgs {
  familyId: string
  /** Pass it if the family row is already loaded; looked up from `families` otherwise. */
  timezone?: string | null
  at?: Date
  limit?: number
  client?: SupabaseClient
  /** Skip the budget read (e.g. a non-generating caller that only wants quota). */
  skipBudget?: boolean
}

export interface PreflightAllowed {
  ok: true
  quota: QuotaSnapshot
  budget: BudgetStatus | null
}

export interface PreflightBlocked {
  ok: false
  status: number
  body: ErrorBody
  quota: QuotaSnapshot | null
  budget: BudgetStatus | null
}

export type PreflightResult = PreflightAllowed | PreflightBlocked

function blocked(
  code: 'service_paused' | 'budget_exceeded' | 'quota_exceeded',
  opts: { resetsAt?: string | null; quota?: QuotaSnapshot | null; budget?: BudgetStatus | null } = {},
): PreflightBlocked {
  return {
    ok: false,
    // The contract maps all three of these; the fallback is a type guard, not a behaviour.
    status: HTTP_STATUS_FOR_ERROR[code] ?? 503,
    body: {
      code,
      message: LIMIT_MESSAGES[code],
      /** Always false here: nothing was generated, so nothing was charged to the family. */
      quota_consumed: false,
      resets_at: opts.resetsAt ?? null,
    },
    quota: opts.quota ?? null,
    budget: opts.budget ?? null,
  }
}

export async function preflight(args: PreflightArgs): Promise<PreflightResult> {
  if (!generationEnabled()) {
    return blocked('service_paused')
  }

  const budget = args.skipBudget ? null : await budgetStatus(args.client)
  if (budget?.exceeded) {
    return blocked('budget_exceeded', { budget })
  }

  const quota = await quotaStatus(args)
  if (quota.remaining <= 0) {
    return blocked('quota_exceeded', { resetsAt: quota.resetsAt, quota, budget })
  }

  return { ok: true, quota, budget }
}

/**
 * Whether generation is available at all right now, ignoring any one family's quota.
 * Feeds `QuotaResponse.generation_enabled` and the /admin header.
 */
export async function generationAvailable(
  client?: SupabaseClient,
): Promise<{ enabled: boolean; reason: 'ok' | 'kill_switch' | 'budget'; budget: BudgetStatus | null }> {
  if (!generationEnabled()) return { enabled: false, reason: 'kill_switch', budget: null }
  const budget = await budgetStatus(client)
  if (budget.exceeded) return { enabled: false, reason: 'budget', budget }
  return { enabled: true, reason: 'ok', budget }
}
