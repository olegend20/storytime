import type { SupabaseClient } from '@supabase/supabase-js'
import { ErrorBody, HTTP_STATUS_FOR_ERROR } from '@/lib/schemas/api'
import { budgetStatus, type BudgetStatus } from '@/lib/costs/budget'
import { LIMIT_MESSAGES } from './messages'
import { creditBalance, creditsApplyTo } from './credits'
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
 *   3. the family's balance of stories is 0 → 402 out_of_stories (issue #128; only when
 *      STORY_CREDITS_ENABLED is on, and never for the owner's family). Before the daily
 *      limit, because a parent with nothing left should not be told to come back at midnight
 *   4. family at the daily story limit → 429 quota_exceeded, with the local reset time
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
  /** The family's balance, when balances apply to it (issue #128). Null otherwise. */
  credits: { balance: number } | null
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
  code: 'service_paused' | 'budget_exceeded' | 'quota_exceeded' | 'out_of_stories',
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

  let credits: { balance: number } | null = null
  if (await creditsApplyTo(args.familyId, args.client)) {
    credits = { balance: await creditBalance(args.familyId, { client: args.client, at: args.at }) }
    if (credits.balance <= 0) {
      return blocked('out_of_stories', { quota, budget })
    }
  }

  if (quota.remaining <= 0) {
    return blocked('quota_exceeded', { resetsAt: quota.resetsAt, quota, budget })
  }

  return { ok: true, quota, budget, credits }
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
