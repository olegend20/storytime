import type { Metadata } from 'next'
import { Landing } from '@/components/landing/Landing'
import { NewStoryFlow } from '@/components/newstory/NewStoryFlow'
import { AppFooter, AppHeader } from '@/components/SiteHeader'
import { currentFamily } from '@/lib/auth/session'
import { kindleConfigured } from '@/lib/kindle/send'
import { creatorInitial } from '@/lib/newstory/initial'
import TimezoneSync from './dashboard/TimezoneSync'
import './landing.css'

export const metadata: Metadata = {
  title: 'The Last Ten — bedtime stories for curious children',
  description:
    'Make the last ten minutes of the day the ones they remember: a bedtime story where your child is the hero, with something true to learn.',
}

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

/**
 * Home (issue #17). A visitor to lastten.org gets the mission and one action; a signed-in
 * parent gets the creator itself, because at 7pm there is only one thing they came to do.
 * Signed in, this is the dashboard's creator in every respect - same family, same timezone
 * sync - so a parent who installs the app at `/` misses nothing.
 *
 * `?deleted=1` is where `DELETE /api/account` sends the parent (F2). It has to be
 * acknowledged somewhere, and this is the only page left that they can still see.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  // One read answers both "is anyone signed in" and "which family".
  const ctx = await currentFamily().catch(() => null)
  if (ctx) {
    return (
      <>
        <AppHeader />
        <TimezoneSync current={ctx.family.timezone} />
        <NewStoryFlow initial={await creatorInitial(ctx)} />
        <AppFooter />
      </>
    )
  }
  return <Landing justDeleted={params.deleted === '1'} kindle={canSendToKindle()} />
}
