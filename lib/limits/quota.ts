import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { DAILY_STORY_LIMIT } from '@/lib/schemas/api'
import { nextResetAtIso, safeTimeZone, usageDateFor } from './timezone'

/**
 * F8: 3 new stories per family per calendar day, where "day" is the family's own.
 *
 * Two rules the rest of the codebase depends on:
 *   1. **Read is not consume.** `quotaStatus()` never moves the counter. Call
 *      `consumeQuota()` only after a successful `stories` insert — refusals, guardrail
 *      blocks and generation failures are free (F8 AC, GUARDRAILS §1.3).
 *   2. **Service role only.** `daily_usage` is readable by the family but not writable,
 *      and `consume_daily_quota` is revoked from `anon`/`authenticated`, so a client cannot
 *      reset its own quota.
 */

export interface QuotaSnapshot {
  used: number
  limit: number
  remaining: number
  /** `daily_usage.usage_date` this snapshot is keyed on, `YYYY-MM-DD` in the family's tz. */
  usageDate: string
  /** Next local midnight, ISO 8601. The "local reset time" the 429 body carries. */
  resetsAt: string
  timezone: string
}

export interface ConsumeResult extends QuotaSnapshot {
  /** False when the family was already at the limit. Nothing was incremented. */
  allowed: boolean
}

interface QuotaArgs {
  familyId: string
  /** The family's IANA zone. Pass it if you already have the row; otherwise it is looked up. */
  timezone?: string | null
  at?: Date
  limit?: number
  client?: SupabaseClient
}

function db(client?: SupabaseClient): SupabaseClient {
  return client ?? supabaseService()
}

/** `families.timezone` for a family, or 'UTC' if the row or column is unusable. */
export async function familyTimeZone(familyId: string, client?: SupabaseClient): Promise<string> {
  const { data, error } = await db(client)
    .from('families')
    .select('timezone')
    .eq('id', familyId)
    .maybeSingle()
  if (error) {
    console.warn(`[limits] could not read timezone for family ${familyId}: ${error.message}`)
    return 'UTC'
  }
  return safeTimeZone((data as { timezone?: string } | null)?.timezone)
}

async function resolveZone(args: QuotaArgs): Promise<string> {
  if (args.timezone) return safeTimeZone(args.timezone)
  return familyTimeZone(args.familyId, args.client)
}

/** Read-only. Safe to call from a GET; never moves the counter. */
export async function quotaStatus(args: QuotaArgs): Promise<QuotaSnapshot> {
  const timezone = await resolveZone(args)
  const at = args.at ?? new Date()
  const limit = args.limit ?? DAILY_STORY_LIMIT
  const usageDate = usageDateFor(timezone, at)

  const { data, error } = await db(args.client)
    .from('daily_usage')
    .select('count')
    .eq('family_id', args.familyId)
    .eq('usage_date', usageDate)
    .maybeSingle()

  if (error) throw new Error(`[limits] quotaStatus failed: ${error.message}`)

  const used = (data as { count?: number } | null)?.count ?? 0
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    usageDate,
    resetsAt: nextResetAtIso(timezone, at),
    timezone,
  }
}

/**
 * Atomically claim one story for today. Returns `allowed: false` if the family is already
 * at the limit — the increment and the limit check happen in the same statement
 * (`insert ... on conflict do update ... where count < limit`), so two concurrent requests
 * at count = 2 cannot both succeed.
 *
 * Call this AFTER the `stories` row is committed.
 */
export async function consumeQuota(args: QuotaArgs): Promise<ConsumeResult> {
  const timezone = await resolveZone(args)
  const at = args.at ?? new Date()
  const limit = args.limit ?? DAILY_STORY_LIMIT
  const usageDate = usageDateFor(timezone, at)

  const { data, error } = await db(args.client).rpc('consume_daily_quota', {
    p_family_id: args.familyId,
    p_usage_date: usageDate,
    p_limit: limit,
  })

  if (error) throw new Error(`[limits] consumeQuota failed: ${error.message}`)

  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed: boolean; used: number; day_limit: number }
    | undefined
  if (!row) throw new Error('[limits] consume_daily_quota returned no row')

  return {
    allowed: row.allowed,
    used: row.used,
    limit: row.day_limit ?? limit,
    remaining: Math.max(0, (row.day_limit ?? limit) - row.used),
    usageDate,
    resetsAt: nextResetAtIso(timezone, at),
    timezone,
  }
}
