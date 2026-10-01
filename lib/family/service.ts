import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { FIELD_MAX_LENGTH, sanitize } from '@/lib/http/sanitize'
import { DEFAULT_TIMEZONE, isValidTimeZone, normalizeTimeZone } from './timezone'
import { isKindleAddress, normalizeKindleAddress } from '@/lib/kindle/address'

/**
 * F2 - the family account. One `families` row per user, created on first login.
 *
 * Every call here goes through a client that respects RLS (`supabaseServer()`), never the
 * service-role client: the family's own data must be reachable only as the family.
 */

export interface FamilyRow {
  id: string
  owner_user_id: string
  display_name: string
  timezone: string
  /** The parent's Send-to-Kindle address, or null. Issue #11. */
  kindle_email: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

/** Postgres unique-violation. Raised by `families_owner_user_id_key` (one family per user). */
const UNIQUE_VIOLATION = '23505'

/**
 * Settings the parent can change. `display_name` is sanitized before validation, so a
 * trailing space or a smuggled tag is cleaned rather than rejected for length.
 */
export const FamilySettingsInput = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, 'Please enter a name for your family.')
    .max(
      FIELD_MAX_LENGTH.display_name,
      `Family names can be up to ${FIELD_MAX_LENGTH.display_name} characters.`,
    )
    .optional(),
  timezone: z
    .string()
    .refine(isValidTimeZone, 'Please choose a timezone from the list.')
    .optional(),
  /** Empty string clears it. */
  kindle_email: z
    .string()
    .trim()
    .max(80)
    .refine(
      (v) => v === '' || isKindleAddress(v),
      'A Send to Kindle address ends in @kindle.com - find it under Manage Your Content and Devices on Amazon.',
    )
    .optional(),
})
export type FamilySettingsInput = z.infer<typeof FamilySettingsInput>

export class FamilyServiceError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'FamilyServiceError'
  }
}

/** The family this user owns, or null when they have none yet. */
export async function getFamily(db: SupabaseClient, userId: string): Promise<FamilyRow | null> {
  const { data, error } = await db
    .from('families')
    .select('*')
    .eq('owner_user_id', userId)
    .maybeSingle()
  if (error) throw new FamilyServiceError(`Could not load the family: ${error.message}`, error)
  return (data as FamilyRow | null) ?? null
}

/**
 * F2 AC: "One family per user; re-login never creates a second family."
 *
 * Idempotent by construction. The read-then-insert is racy on a double-clicked magic
 * link, so the unique index is the real guarantee and a 23505 is treated as "someone else
 * just created it" rather than an error.
 */
export async function ensureFamily(
  db: SupabaseClient,
  userId: string,
  options: { timezone?: string | null } = {},
): Promise<FamilyRow> {
  const existing = await getFamily(db, userId)
  if (existing) return existing

  const timezone = options.timezone ? normalizeTimeZone(options.timezone) : DEFAULT_TIMEZONE
  const { data, error } = await db
    .from('families')
    .insert({ owner_user_id: userId, timezone })
    .select('*')
    .single()

  if (!error) return data as FamilyRow

  if (error.code === UNIQUE_VIOLATION) {
    const raced = await getFamily(db, userId)
    if (raced) return raced
    // The row exists but this user cannot see it: the RLS select policy hides
    // `deleted_at is not null`. Nothing in the app sets that - account deletion is a
    // hard delete - so reaching here means someone soft-deleted a family by hand.
    throw new FamilyServiceError(
      'This account already has a family record that is not visible to it. ' +
        'A soft-deleted `families` row is the usual cause.',
    )
  }
  throw new FamilyServiceError(`Could not create the family: ${error.message}`, error)
}

/** Apply a settings patch. Returns the updated row. */
export async function updateFamily(
  db: SupabaseClient,
  familyId: string,
  patch: FamilySettingsInput,
): Promise<FamilyRow> {
  const update: Record<string, string | null> = {}
  if (patch.display_name !== undefined) update.display_name = patch.display_name
  if (patch.timezone !== undefined) update.timezone = normalizeTimeZone(patch.timezone)
  if (patch.kindle_email !== undefined) {
    update.kindle_email = patch.kindle_email === '' ? null : normalizeKindleAddress(patch.kindle_email)
  }
  if (Object.keys(update).length === 0) {
    const current = await db.from('families').select('*').eq('id', familyId).single()
    if (current.error) throw new FamilyServiceError(current.error.message, current.error)
    return current.data as FamilyRow
  }

  const { data, error } = await db
    .from('families')
    .update(update)
    .eq('id', familyId)
    .select('*')
    .single()
  if (error) throw new FamilyServiceError(`Could not save your settings: ${error.message}`, error)
  return data as FamilyRow
}

/**
 * Sanitize a raw settings payload before it is validated.
 *
 * `display_name` is not cut to length, for the same reason as a child's first name: see
 * the note on `sanitizeChildPayload`.
 */
export function sanitizeFamilySettings(raw: unknown): {
  input: Record<string, unknown>
  containedHtml: boolean
  htmlField: string | null
} {
  const body = (raw ?? {}) as Record<string, unknown>
  const input: Record<string, unknown> = {}
  let htmlField: string | null = null

  if (body.display_name !== undefined) {
    const cleaned = sanitize('display_name', body.display_name, { cap: false })
    if (cleaned.removed.html) htmlField = 'display_name'
    input.display_name = cleaned.value
  }
  if (body.timezone !== undefined) {
    // A zone name has no free text in it: clean it as a title and let validation reject
    // anything that is not a real IANA name.
    const cleaned = sanitize('title', body.timezone)
    if (cleaned.removed.html) htmlField = htmlField ?? 'timezone'
    input.timezone = cleaned.value
  }
  if (body.kindle_email !== undefined) {
    const cleaned = sanitize('title', body.kindle_email)
    if (cleaned.removed.html) htmlField = htmlField ?? 'kindle_email'
    input.kindle_email = cleaned.value
  }
  return { input, containedHtml: htmlField !== null, htmlField }
}

export interface DeletionCounts {
  children: number
  series: number
  story_bibles: number
  stories: number
}

export interface AccountDeletionResult {
  family_id: string
  /** What was removed, counted before the delete. */
  removed: DeletionCounts
  /** Rows kept for cost history, now anonymized (`family_id is null`). */
  anonymized_generation_logs: number
}

async function countFor(
  db: SupabaseClient,
  table: keyof DeletionCounts,
  familyId: string,
): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
  if (error) throw new FamilyServiceError(`Could not count ${table}: ${error.message}`, error)
  return count ?? 0
}

/**
 * F2 AC: "Delete account removes all family-scoped rows within one transaction."
 *
 * One statement, so one transaction by definition: deleting the `families` row cascades
 * to children, series, story_bibles, stories and daily_usage through the `on delete
 * cascade` foreign keys declared in the initial migration. Referential actions are run by
 * the system and are not filtered by RLS, so the cascade is complete even though the
 * caller can only see its own rows.
 *
 * `generation_logs.family_id` and `guardrail_events.family_id` are `on delete set null`,
 * so the cost history survives the delete already anonymized - it is not re-implemented
 * here, only verified.
 *
 * @param db     a client authenticated AS the owner; the RLS delete policy is the authority
 * @param serviceDb optional service-role client used only to remove the `auth.users` row
 */
export async function deleteAccount(
  db: SupabaseClient,
  userId: string,
  options: { serviceDb?: SupabaseClient } = {},
): Promise<AccountDeletionResult | null> {
  const family = await getFamily(db, userId)
  if (!family) return null

  const removed: DeletionCounts = {
    children: await countFor(db, 'children', family.id),
    series: await countFor(db, 'series', family.id),
    story_bibles: await countFor(db, 'story_bibles', family.id),
    stories: await countFor(db, 'stories', family.id),
  }

  const { data, error } = await db.from('families').delete().eq('id', family.id).select('id')
  if (error) {
    throw new FamilyServiceError(`Could not delete the account: ${error.message}`, error)
  }
  if (!data || data.length === 0) {
    throw new FamilyServiceError('Could not delete the account: no row was removed.')
  }

  let anonymized = 0
  if (options.serviceDb) {
    // Only the service role can see generation_logs, so the verification is optional.
    const { count } = await options.serviceDb
      .from('generation_logs')
      .select('id', { count: 'exact', head: true })
      .is('family_id', null)
    anonymized = count ?? 0
    // Remove the auth user too, so "delete my account" means what it says. The families
    // row is already gone, so this cascades over nothing.
    await options.serviceDb.auth.admin.deleteUser(userId)
  }

  return { family_id: family.id, removed, anonymized_generation_logs: anonymized }
}
