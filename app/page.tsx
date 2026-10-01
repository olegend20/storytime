import type { Metadata } from 'next'
import { Landing } from '@/components/landing/Landing'
import { NewStoryFlow } from '@/components/newstory/NewStoryFlow'
import { AppFooter, AppHeader } from '@/components/SiteHeader'
import { currentFamilyIfAny, currentUser } from '@/lib/auth/session'
import { creatorInitial } from '@/lib/newstory/initial'
import { kindleConfigured } from '@/lib/kindle/send'
import './landing.css'

export const metadata: Metadata = {
  title: 'The Last Ten — bedtime stories for curious children',
  description:
    'Make the last ten minutes of the day the ones they remember: a bedtime story where your child is the hero, with something true to learn.',
}

/**
 * Home (issue #17). A visitor to lastten.org gets the mission and one action; a signed-in
 * parent gets the creator itself, because at 7pm there is only one thing they came to do.
 *
 * `?deleted=1` is where `DELETE /api/account` sends the parent (F2). It has to be
 * acknowledged somewhere, and this is the only page left that they can still see.
 */
/**
 * `kindleConfigured()` reads the validated server env, which throws when a required variable
 * is missing. The landing page must still render then - it is the one page with nothing to
 * configure - so a failure here just means the page does not mention Kindle.
 */
function canSendToKindle(): boolean {
  try {
    return kindleConfigured()
  } catch {
    return false
  }
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const signedIn = (await currentUser().catch(() => null)) !== null
  if (signedIn) {
    // Read what the creator needs here when we can, so it opens with its heroes already named.
    const ctx = await currentFamilyIfAny().catch(() => null)
    const initial = ctx ? await creatorInitial(ctx) : undefined
    return (
      <>
        <AppHeader />
        <NewStoryFlow initial={initial} />
        <AppFooter />
      </>
    )
  }
  return <Landing signedIn={false} justDeleted={params.deleted === '1'} kindle={canSendToKindle()} />
}
