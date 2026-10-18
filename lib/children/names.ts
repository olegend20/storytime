import namesConfig from '@/config/child-names.json'
import { ChildFirstName } from '@/lib/schemas'

/**
 * Issue #43: a parent may leave a child's name blank, and we choose one from a fixed list
 * (owner's decision: no model call, so it costs nothing and is the same kind of name every
 * time). The chosen name is SAVED as the child's first name, so the story bible, the
 * quality gate, the library and Kindle all see one stable name exactly as if it were typed.
 */
export const GENERATED_CHILD_NAMES: readonly string[] = namesConfig.names.map((n) =>
  ChildFirstName.parse(n),
)

/**
 * A name from the list that no sibling already has (case-insensitive). With eight children
 * at most and forty names there is always one free; the fallback only guards a hand-edited
 * list.
 */
export function pickGeneratedName(siblingNames: readonly string[], random: () => number = Math.random): string {
  const taken = new Set(siblingNames.map((n) => n.trim().toLocaleLowerCase()))
  const free = GENERATED_CHILD_NAMES.filter((n) => !taken.has(n.toLocaleLowerCase()))
  const pool = free.length > 0 ? free : GENERATED_CHILD_NAMES
  return pool[Math.floor(random() * pool.length) % pool.length]!
}
