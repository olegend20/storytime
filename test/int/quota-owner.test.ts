import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ensureFamily } from '@/lib/family/service'
import { consumeQuota, quotaStatus, UNLIMITED_DAILY_LIMIT } from '@/lib/limits/quota'
import { DAILY_STORY_LIMIT } from '@/lib/schemas'
import { quotaMessage } from '@/components/newstory/QuotaIndicator'
import {
  cleanupUser,
  createTestUser,
  localDbAvailable,
  serviceClient,
  SKIP_REASON,
  type TestUser,
} from './support/lane1-db'

/**
 * DECISIONS #141: the owner's own family is exempt from the daily story limit. Everyone else
 * is not, and an unset OWNER_USER_ID exempts nobody.
 */
const dbUp = await localDbAvailable()
if (!dbUp) console.warn(`[quota owner int] skipped: ${SKIP_REASON}`)

describe.runIf(dbUp)('the owner is exempt from the daily story limit', () => {
  let owner: TestUser
  let parent: TestUser
  let ownerFamily: string
  let parentFamily: string
  const saved = process.env.OWNER_USER_ID

  beforeAll(async () => {
    owner = await createTestUser('quota-owner')
    parent = await createTestUser('quota-parent')
    ownerFamily = (await ensureFamily(owner.client, owner.userId)).id
    parentFamily = (await ensureFamily(parent.client, parent.userId)).id
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.OWNER_USER_ID
    else process.env.OWNER_USER_ID = saved
  })
  afterAll(async () => {
    await cleanupUser(owner)
    await cleanupUser(parent)
  })

  it('lets the owner past the limit, still counting every story', async () => {
    process.env.OWNER_USER_ID = owner.userId
    const status = await quotaStatus({ familyId: ownerFamily, client: serviceClient() })
    expect(status.unlimited).toBe(true)
    expect(status.limit).toBe(UNLIMITED_DAILY_LIMIT)

    let last = status
    for (let i = 0; i < DAILY_STORY_LIMIT + 2; i += 1) {
      const c = await consumeQuota({ familyId: ownerFamily, client: serviceClient() })
      expect(c.allowed, `story ${i + 1}`).toBe(true)
      last = c
    }
    expect(last.used).toBe(DAILY_STORY_LIMIT + 2)
    expect(quotaMessage({ used: last.used, limit: last.limit, resets_at: last.resetsAt, generation_enabled: true })).toMatch(
      /^Unlimited stories \(owner account\) · 5 today$/,
    )
  })

  it('holds everyone else to the limit, the owner included when nobody is the owner', async () => {
    process.env.OWNER_USER_ID = owner.userId
    const other = await quotaStatus({ familyId: parentFamily, client: serviceClient() })
    expect(other.unlimited).toBe(false)
    expect(other.limit).toBe(DAILY_STORY_LIMIT)

    delete process.env.OWNER_USER_ID
    const nobody = await quotaStatus({ familyId: ownerFamily, client: serviceClient() })
    expect(nobody.unlimited).toBe(false)
    expect(nobody.limit).toBe(DAILY_STORY_LIMIT)
  })
})
