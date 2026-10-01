import { currentFamilyIfAny } from '@/lib/auth/session'
import { apiError, apiOk } from '@/lib/http/responses'
import { getLibraryStory } from '@/lib/stories/library'
import { KindleSendError, sendStoryToKindle } from '@/lib/kindle/send'

/**
 * POST /api/stories/:id/kindle - email this story to the family's Kindle (issue #11).
 *
 * The story is read through the caller's RLS client, so another family's id is a 404 like
 * everywhere else. The send itself runs with the service role (the sends log is server-only).
 */
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(_req: Request, { params }: Ctx) {
  const ctx = await currentFamilyIfAny()
  if (!ctx) return apiError('unauthorized', 'Please sign in.')
  const { id } = await params
  let story: Awaited<ReturnType<typeof getLibraryStory>>
  try {
    story = await getLibraryStory(ctx.db, id)
  } catch (err) {
    console.error('[kindle] story read failed:', err)
    return apiError('server_error', "We couldn't load that story. Please try again.")
  }
  if (!story) return apiError('not_found', 'Story not found.')

  try {
    const result = await sendStoryToKindle({
      familyId: ctx.family.id,
      kindleEmail: ctx.family.kindle_email,
      timezone: ctx.family.timezone,
      story: { id: story.id, title: story.title, content: story.content },
      childNames: story.child_names,
    })
    return apiOk({ sent: { to: result.to, filename: result.filename, sent_today: result.sentToday } })
  } catch (err) {
    if (err instanceof KindleSendError) {
      const code = err.code === 'daily_limit' ? 'rate_limited' : err.code
      return apiError(code, err.message)
    }
    console.error('[kindle] unexpected failure:', err)
    return apiError('server_error', "We couldn't send that story. Please try again.")
  }
}
