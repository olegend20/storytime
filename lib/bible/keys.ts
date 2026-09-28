import { createHash } from 'node:crypto'

/**
 * A series is keyed by the EXACT sorted set of child ids (IMPLEMENTATION_PLAN.md §3):
 * "Cruz + Phoenix" and "Lennon" are different series with different recurring characters,
 * and "Cruz + Phoenix + Lennon" is a third. The key must not depend on the order the
 * parent happened to tick the boxes in.
 *
 * F4 VT: childKey([b, a]) === childKey([a, b]).
 */
export function childKey(childIds: readonly string[]): string {
  const unique = [...new Set(childIds.map((id) => id.trim().toLowerCase()))].sort()
  if (unique.length === 0) throw new Error('childKey: no child ids given')
  return createHash('sha256').update(unique.join(',')).digest('hex').slice(0, 32)
}

/** The canonical `child_ids` array stored on the series row: sorted, de-duplicated. */
export function sortedChildIds(childIds: readonly string[]): string[] {
  return [...new Set(childIds)].sort()
}
