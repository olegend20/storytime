import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { dailyBudgetUsd } from '@/lib/limits/switches'

/**
 * F8: the global daily budget cap. Once today's total spend across every model call passes
 * `DAILY_BUDGET_USD`, generation is refused with 503 "paused for today".
 *
 * The number comes from the `v_budget_today` SQL view, never from an in-process counter
 * (F12 AC, and a counter would reset on every cold start and be wrong per lambda).
 *
 * "Today" is the database day (UTC). Unlike the per-family quota there is no single
 * timezone to key a global cap on; see DECISIONS.md.
 */

export interface BudgetStatus {
  /** `DAILY_BUDGET_USD`, read fresh from the environment. */
  limitUsd: number
  spentUsd: number
  remainingUsd: number
  exceeded: boolean
  calls: number
  failedCalls: number
  /** The database day the spend was measured over, `YYYY-MM-DD`. */
  day: string | null
}

interface BudgetRow {
  day: string | null
  spent_usd: number | string | null
  calls: number | null
  failed_calls: number | null
}

export async function budgetStatus(client?: SupabaseClient): Promise<BudgetStatus> {
  const db = client ?? supabaseService()
  const limitUsd = dailyBudgetUsd()

  const { data, error } = await db
    .from('v_budget_today')
    .select('day, spent_usd, calls, failed_calls')
    .maybeSingle()

  if (error) throw new Error(`[costs] budgetStatus failed: ${error.message}`)

  const row = data as BudgetRow | null
  // numeric comes back as a string from PostgREST; Number('') would be 0, so guard null.
  const spentUsd = row?.spent_usd == null ? 0 : Number(row.spent_usd)

  return {
    limitUsd,
    spentUsd,
    remainingUsd: Math.max(0, Math.round((limitUsd - spentUsd) * 1e6) / 1e6),
    exceeded: spentUsd >= limitUsd,
    calls: row?.calls ?? 0,
    failedCalls: row?.failed_calls ?? 0,
    day: row?.day ?? null,
  }
}
