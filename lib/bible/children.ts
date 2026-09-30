import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { bandForAges, type AgeBand } from '@/lib/schemas'
import type { BibleChild } from '@/lib/schemas'

/**
 * Read-only view of children for the AI core. Lane 1 owns children CRUD (F3); this is
 * only the lookup the generation path and the bible service need, scoped to one family so
 * a child id from another family cannot be smuggled in.
 */

export interface ChildProfile {
  id: string
  first_name: string
  age: number
  likes: string[]
  notes: string | null
  reading_level: 'younger' | 'typical' | 'older' | null
}

export class UnknownChildrenError extends Error {
  constructor(readonly missing: string[]) {
    super(`Some selected children do not belong to this family: ${missing.length} missing`)
    this.name = 'UnknownChildrenError'
  }
}

/**
 * Children for this family, in the order the caller asked for them.
 * Throws UnknownChildrenError when any id is not in the family - the pipeline turns that
 * into `invalid_request` rather than silently writing a story for fewer children.
 */
export async function loadChildProfiles(
  familyId: string,
  childIds: readonly string[],
  db: SupabaseClient = supabaseService(),
): Promise<ChildProfile[]> {
  const ids = [...new Set(childIds)]
  const { data, error } = await db
    .from('children')
    .select('id, first_name, age, likes, notes, reading_level')
    .eq('family_id', familyId)
    .in('id', ids)
  if (error) throw new Error(`loadChildProfiles: ${error.message}`)

  const rows = (data ?? []) as ChildProfile[]
  const found = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0) throw new UnknownChildrenError(missing)

  return ids.map((id) => found.get(id)!)
}

/** §4.5: vocabulary and peril follow the youngest selected child. */
export function bandForChildren(children: readonly ChildProfile[]): AgeBand {
  return bandForAges(children.map((c) => c.age))
}

/** Profile → the bible's own child shape. `role_notes` is series memory, not profile data. */
export function toBibleChild(child: ChildProfile, roleNotes: string | null = null): BibleChild {
  return {
    name: child.first_name,
    age: child.age,
    likes: child.likes ?? [],
    role_notes: roleNotes,
  }
}
