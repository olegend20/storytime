import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Issue #110: ADMIN_USER_IDS lets more accounts open /admin, besides OWNER_USER_ID. Admin
 * pages only - the unlimited daily quota (lib/owner.ts, DECISIONS #141) stays with the owner.
 * The auth lookup is stubbed; the gate and Next's real `notFound()` are not.
 */

const session = vi.hoisted(() => ({ userId: null as string | null }))

vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }) },
  }),
}))

const { adminUserIds, isAdmin, requireOwner, currentUserIsOwner } = await import('@/lib/admin/gate')
const quotaOwner = await import('@/lib/owner')

const OWNER = '2e8ae912-fe9a-47a1-9b69-48803d85d46e'
const SECOND = 'f9175146-ed9b-49b5-a095-41c664fcc141'
const PARENT = '3fcaadc7-00d9-476c-bb9b-878b89443827'

const saved = { owner: process.env.OWNER_USER_ID, admins: process.env.ADMIN_USER_IDS }

function restore(key: 'OWNER_USER_ID' | 'ADMIN_USER_IDS', value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  session.userId = null
  restore('OWNER_USER_ID', saved.owner)
  restore('ADMIN_USER_IDS', saved.admins)
})

function is404(err: unknown): boolean {
  const digest = (err as { digest?: string })?.digest ?? (err as Error)?.message ?? ''
  return /404|NEXT_NOT_FOUND/.test(String(digest))
}

describe('#110 ADMIN_USER_IDS', () => {
  it('a listed id is an admin; an unlisted one is not', () => {
    process.env.OWNER_USER_ID = OWNER
    process.env.ADMIN_USER_IDS = SECOND
    expect(isAdmin(SECOND)).toBe(true)
    expect(isAdmin(PARENT)).toBe(false)
    expect(isAdmin(null)).toBe(false)
    expect(isAdmin('')).toBe(false)
  })

  it('the owner stays an admin when ADMIN_USER_IDS is set', () => {
    process.env.OWNER_USER_ID = OWNER
    process.env.ADMIN_USER_IDS = SECOND
    expect(isAdmin(OWNER)).toBe(true)
  })

  it('unset or blank adds nobody, and with both unset nobody is an admin', () => {
    process.env.OWNER_USER_ID = OWNER
    delete process.env.ADMIN_USER_IDS
    expect(isAdmin(SECOND)).toBe(false)
    process.env.ADMIN_USER_IDS = '  '
    expect(adminUserIds()).toEqual([])
    expect(isAdmin(SECOND)).toBe(false)
    delete process.env.OWNER_USER_ID
    delete process.env.ADMIN_USER_IDS
    expect(isAdmin(OWNER)).toBe(false)
  })

  it('ignores spaces and empty entries; a non-uuid entry matches nobody', () => {
    process.env.ADMIN_USER_IDS = ` ${SECOND} ,, not-a-uuid, ${PARENT.toUpperCase()} `
    expect(adminUserIds()).toEqual([SECOND, PARENT])
    expect(isAdmin('not-a-uuid')).toBe(false)
    expect(isAdmin(PARENT)).toBe(true)
  })

  it('requireOwner 404s for a non-admin and returns the id for a listed admin', async () => {
    process.env.OWNER_USER_ID = OWNER
    process.env.ADMIN_USER_IDS = SECOND

    session.userId = PARENT
    await expect(requireOwner()).rejects.toSatisfy(is404, 'a non-admin must get a 404, not a 403')
    expect(await currentUserIsOwner()).toBe(false)

    session.userId = null
    await expect(requireOwner()).rejects.toSatisfy(is404)

    session.userId = SECOND
    await expect(requireOwner()).resolves.toBe(SECOND)
    expect(await currentUserIsOwner()).toBe(true)
  })

  it('a listed admin does not get the owner quota exemption', () => {
    process.env.OWNER_USER_ID = OWNER
    process.env.ADMIN_USER_IDS = SECOND
    expect(quotaOwner.isOwner(SECOND)).toBe(false)
    expect(quotaOwner.isOwner(OWNER)).toBe(true)
  })
})
