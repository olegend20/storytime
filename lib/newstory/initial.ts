import type { FamilyContext } from '@/lib/auth/session'
import { listChildren } from '@/lib/children/service'
import { quotaResponseFor } from '@/lib/limits/quota-response'
import { Child, type QuotaResponse, type SuggestedTopicsResponse } from '@/lib/schemas'
import { suggestedTopics } from '@/lib/stories/library'

/**
 * What the creator needs to open, read on the server (issue #17).
 *
 * The creator is the home page now, so it is opened every night; reading its three inputs
 * while rendering the page means it appears complete, and makes no API request of its own
 * until the parent does something. Each piece is exactly what its API route would have
 * returned to this parent, and each fails soft: a missing piece is simply fetched by the
 * client as before.
 */
export interface CreatorInitial {
  children?: Child[]
  quota?: QuotaResponse
  topics?: SuggestedTopicsResponse['topics']
}

export async function creatorInitial(ctx: FamilyContext): Promise<CreatorInitial> {
  const soft = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined)
  const [children, quota, topics] = await Promise.all([
    soft(listChildren(ctx.db, ctx.family.id).then((rows) => rows.map((row) => Child.parse(row)))),
    soft(quotaResponseFor({ id: ctx.family.id, timezone: ctx.family.timezone })),
    soft(suggestedTopics(ctx.db).then((res) => res.topics)),
  ])
  return { children, quota, topics }
}
