import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'

/**
 * Issue #128: a family's balance of stories.
 *
 * Sits beside the daily quota, not instead of it: the 3-a-day limit stays as the guard
 * against abuse, and the balance is what a family has been given (three free stories now;
 * a month's allowance or a pack once paying exists).
 *
 * The same two rules as `quota.ts`:
 *   1. **Read is not consume.** `creditBalance()` never moves anything. `consumeCredit()` is
 *      called only after a successful `stories` insert, so refusals and failures are free.
 *   2. **Service role only.** A family can read its own grants and write none.
 *
 * Everything here is inert unless `STORY_CREDITS_ENABLED=true`. Off is the default, and with
 * it off no caller reads or writes a grant.
 */

export type CreditReason = 'trial' | 'subscription' | 'top_up' | 'adjustment'

/**
 * The switch. Read from `process.env` on every call, like the kill switch, so it takes
 * effect without a rebuild. Fails CLOSED to off: an unparseable value must not start
 * counting stories against families nobody meant to limit.
 */
export function storyCreditsEnabled(): boolean {
  const v = process.env.STORY_CREDITS_ENABLED?.trim().toLowerCase()
  return v === 'true' || v === '1'
}

function db(client?: SupabaseClient): SupabaseClient {
  return client ?? supabaseService()
}

/**
 * Whether the balance applies to a family: the switch is on and it is not the owner's own
 * family, which stays unlimited (DECISIONS #141). Takes the quota already read for the
 * request, so asking costs no query.
 */
export function creditsApplyTo(quota: { unlimited: boolean }): boolean {
  return storyCreditsEnabled() && !quota.unlimited
}

/**
 * Read-only: the stories left on grants that have not expired. Counted in the database
 * (`story_credit_balance`), by the same clock that `consume_story_credit` uses, so what a
 * parent is shown and what can be taken cannot disagree around an expiry.
 */
export async function creditBalance(familyId: string, client?: SupabaseClient): Promise<number> {
  const { data, error } = await db(client).rpc('story_credit_balance', { p_family_id: familyId })
  if (error) throw new Error(`[limits] creditBalance failed: ${error.message}`)
  if (typeof data !== 'number') throw new Error('[limits] story_credit_balance returned no number')
  return data
}

export interface ConsumeCreditResult {
  /** False when the balance was already 0. Nothing moved. */
  taken: boolean
  balance: number
}

/**
 * Take one story, from the grant that expires soonest. Atomic in the database
 * (`consume_story_credit`): two stories saved at once cannot both take the last one.
 *
 * Call this AFTER the `stories` row is committed.
 */
export async function consumeCredit(familyId: string, client?: SupabaseClient): Promise<ConsumeCreditResult> {
  const { data, error } = await db(client).rpc('consume_story_credit', { p_family_id: familyId })
  if (error) throw new Error(`[limits] consumeCredit failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { taken: boolean; balance: number } | undefined
  if (!row) throw new Error('[limits] consume_story_credit returned no row')
  return { taken: row.taken, balance: row.balance }
}

export interface GrantCreditsArgs {
  familyId: string
  amount: number
  reason: CreditReason
  /**
   * Names what this grant is for, once and for all (a payment's id, `trial:<family>`).
   * Granting again with the same reference adds nothing.
   */
  sourceRef: string
  /** Omit for stories that never expire. */
  expiresAt?: Date | null
  client?: SupabaseClient
}

export interface GrantCreditsResult {
  /** False when this `sourceRef` had already been granted. */
  granted: boolean
  balance: number
}

export async function grantCredits(args: GrantCreditsArgs): Promise<GrantCreditsResult> {
  const { data, error } = await db(args.client).rpc('grant_story_credits', {
    p_family_id: args.familyId,
    p_amount: args.amount,
    p_reason: args.reason,
    p_source_ref: args.sourceRef,
    p_expires_at: args.expiresAt ? args.expiresAt.toISOString() : null,
  })
  if (error) throw new Error(`[limits] grantCredits failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { granted: boolean; balance: number } | undefined
  if (!row) throw new Error('[limits] grant_story_credits returned no row')
  return { granted: row.granted, balance: row.balance }
}
