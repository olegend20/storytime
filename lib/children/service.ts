import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  ChildAge,
  ChildFirstName,
  ChildInput,
  ChildLike,
  MAX_CHILDREN_PER_FAMILY,
  ReadingLevel,
} from '@/lib/schemas'
import { FIELD_MAX_LENGTH, sanitize, sanitizeLikes } from '@/lib/http/sanitize'

/**
 * F3 - children profiles. CRUD against `children`, RLS-scoped to the caller's family.
 *
 * The field list is closed (kickoff rule 7): first name, age, likes, notes, reading level.
 * `ChildInput` in `lib/schemas/child.ts` is the shared contract and is used verbatim; the
 * patch schema below composes its pieces rather than restating the rules.
 */

export interface ChildRow {
  id: string
  family_id: string
  first_name: string
  age: number
  likes: string[]
  notes: string | null
  reading_level: 'younger' | 'typical' | 'older' | null
  created_at: string
  updated_at: string
}

const SELECT_COLUMNS = 'id,family_id,first_name,age,likes,notes,reading_level,created_at,updated_at'

/** PATCH accepts any subset of the fields; every rule is reused from `ChildInput`'s parts. */
export const ChildPatch = z
  .object({
    first_name: ChildFirstName.optional(),
    age: ChildAge.optional(),
    likes: z.array(ChildLike).max(10, 'Up to 10 likes per child.').optional(),
    notes: z
      .string()
      .trim()
      .max(FIELD_MAX_LENGTH.notes, 'Notes can be up to 300 characters.')
      .nullable()
      .optional(),
    reading_level: ReadingLevel.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'There is nothing to update.')
export type ChildPatch = z.infer<typeof ChildPatch>

export class ChildLimitError extends Error {
  readonly limit = MAX_CHILDREN_PER_FAMILY
  constructor() {
    super(
      `You can add up to ${MAX_CHILDREN_PER_FAMILY} children. ` +
        'Remove one before adding another.',
    )
    this.name = 'ChildLimitError'
  }
}

export class ChildServiceError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'ChildServiceError'
  }
}

export async function listChildren(db: SupabaseClient, familyId: string): Promise<ChildRow[]> {
  const { data, error } = await db
    .from('children')
    .select(SELECT_COLUMNS)
    .eq('family_id', familyId)
    .order('created_at', { ascending: true })
  if (error) throw new ChildServiceError(`Could not load children: ${error.message}`, error)
  return (data ?? []) as unknown as ChildRow[]
}

export async function countChildren(db: SupabaseClient, familyId: string): Promise<number> {
  const { count, error } = await db
    .from('children')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
  if (error) throw new ChildServiceError(`Could not count children: ${error.message}`, error)
  return count ?? 0
}

export async function getChild(
  db: SupabaseClient,
  familyId: string,
  childId: string,
): Promise<ChildRow | null> {
  const { data, error } = await db
    .from('children')
    .select(SELECT_COLUMNS)
    .eq('family_id', familyId)
    .eq('id', childId)
    .maybeSingle()
  if (error) throw new ChildServiceError(`Could not load the child: ${error.message}`, error)
  return (data as unknown as ChildRow | null) ?? null
}

/**
 * F3 AC: max 8 children per family, enforced on the server.
 *
 * The count-then-insert is racy under two simultaneous submissions; the ceiling is small
 * and the consequence of losing the race is a 9th row rather than a security problem, so
 * it is not worth a serialized transaction. A parent double-clicking "Add" is the only
 * realistic case and the second request sees the first one's row.
 */
export async function createChild(
  db: SupabaseClient,
  familyId: string,
  input: ChildInput,
): Promise<ChildRow> {
  const existing = await countChildren(db, familyId)
  if (existing >= MAX_CHILDREN_PER_FAMILY) throw new ChildLimitError()

  const { data, error } = await db
    .from('children')
    .insert({
      family_id: familyId,
      first_name: input.first_name,
      age: input.age,
      likes: input.likes,
      notes: input.notes,
      reading_level: input.reading_level,
    })
    .select(SELECT_COLUMNS)
    .single()
  if (error) throw new ChildServiceError(`Could not save the child: ${error.message}`, error)
  return data as unknown as ChildRow
}

export async function updateChild(
  db: SupabaseClient,
  familyId: string,
  childId: string,
  patch: ChildPatch,
): Promise<ChildRow | null> {
  const { data, error } = await db
    .from('children')
    .update(patch)
    .eq('family_id', familyId)
    .eq('id', childId)
    .select(SELECT_COLUMNS)
    .maybeSingle()
  if (error) throw new ChildServiceError(`Could not save the change: ${error.message}`, error)
  return (data as unknown as ChildRow | null) ?? null
}

export interface ChildDeletionResult {
  id: string
  /**
   * How many series still list this child. F3 AC: deleting a child must not break an
   * existing series. `series.child_ids` is a uuid[] with no foreign key, so those rows
   * are left exactly as they are - see DECISIONS.md.
   */
  affected_series: number
}

export async function deleteChild(
  db: SupabaseClient,
  familyId: string,
  childId: string,
): Promise<ChildDeletionResult | null> {
  const seriesCount = await db
    .from('series')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .contains('child_ids', [childId])
  if (seriesCount.error) {
    throw new ChildServiceError(
      `Could not check this child's series: ${seriesCount.error.message}`,
      seriesCount.error,
    )
  }

  const { data, error } = await db
    .from('children')
    .delete()
    .eq('family_id', familyId)
    .eq('id', childId)
    .select('id')
  if (error) throw new ChildServiceError(`Could not delete the child: ${error.message}`, error)
  if (!data || data.length === 0) return null
  return { id: childId, affected_series: seriesCount.count ?? 0 }
}

export interface SanitizedChildPayload {
  input: Record<string, unknown>
  /** The first field that contained HTML, or null. F11 AC rejects those payloads. */
  htmlField: string | null
}

/**
 * Clean a raw child payload before validation (GUARDRAILS.md s3.2).
 *
 * Only keys the client actually sent are returned, so the same function serves POST
 * (validated with `ChildInput`) and PATCH (validated with `ChildPatch`).
 *
 * `first_name` and `notes` are cleaned but deliberately NOT cut to length (`cap: false`).
 * s3.2's "enforce max lengths" is the right default for a programmatic caller, but at a
 * parent-facing endpoint silently shortening someone's child's name is worse than saying
 * "First names can be up to 30 characters" - and the F3 AC asks for that length to be
 * *validated* on the server, which a pre-truncated value could never fail. Likes are the
 * exception and are still capped at 40 characters each: a trimmed tag loses nothing, and
 * `ChildLike` in the shared contract has no custom message to show instead.
 */
export function sanitizeChildPayload(raw: unknown): SanitizedChildPayload {
  const body = (raw ?? {}) as Record<string, unknown>
  const input: Record<string, unknown> = {}
  let htmlField: string | null = null
  const flag = (field: string, hadHtml: boolean) => {
    if (hadHtml && htmlField === null) htmlField = field
  }

  if ('first_name' in body) {
    const cleaned = sanitize('first_name', body.first_name, { cap: false })
    flag('first_name', cleaned.removed.html)
    input.first_name = cleaned.value
  }
  if ('age' in body) {
    // Forms post numbers as strings; coerce here so the schema's own message is shown.
    const raw = body.age
    input.age = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  }
  if ('likes' in body) {
    const cleaned = sanitizeLikes(body.likes)
    flag('likes', cleaned.removed.html)
    input.likes = cleaned.value
  }
  if ('notes' in body) {
    if (body.notes === null) {
      input.notes = null
    } else {
      const cleaned = sanitize('notes', body.notes, { cap: false })
      flag('notes', cleaned.removed.html)
      input.notes = cleaned.value === '' ? null : cleaned.value
    }
  }
  if ('reading_level' in body) {
    input.reading_level =
      body.reading_level === '' || body.reading_level === undefined ? null : body.reading_level
  }
  return { input, htmlField }
}

export { MAX_CHILDREN_PER_FAMILY }
