import { QuotaResponse } from '@/lib/schemas/api'
import { generationAvailable } from './guard'
import { quotaStatus } from './quota'

/**
 * The quota a parent is shown ("2 of 3 stories left today"), as `GET /api/quota` returns it.
 *
 * One function, so the API route and the pages that render the creator on the server
 * (issue #17) cannot disagree. Reads only: quota is consumed by `consumeQuota()` after a
 * successful story insert, never here.
 */
export async function quotaResponseFor(family: { id: string; timezone: string }): Promise<QuotaResponse> {
  const [quota, availability] = await Promise.all([
    quotaStatus({ familyId: family.id, timezone: family.timezone }),
    generationAvailable(),
  ])
  return QuotaResponse.parse({
    used: quota.used,
    limit: quota.limit,
    ...(quota.unlimited ? { unlimited: true } : {}),
    resets_at: quota.resetsAt,
    generation_enabled: availability.enabled,
  })
}
