/**
 * Who the owner is: the user named by `OWNER_USER_ID`. Gates /admin (lib/admin/gate.ts) and,
 * since 2026-09-29, exempts the owner's own family from the daily story limit (DECISIONS
 * #141) - so the person who tests the product is not stopped by a rule written for parents.
 *
 * Read fresh from the environment on every call, so rotating the owner needs no rebuild.
 * Unset means nobody is the owner: every check fails closed.
 */
export function ownerUserId(): string | null {
  const raw = process.env.OWNER_USER_ID?.trim()
  return raw && raw.length > 0 ? raw : null
}

export function isOwner(userId: string | null | undefined): boolean {
  const owner = ownerUserId()
  if (!owner) return false
  return typeof userId === 'string' && userId === owner
}
