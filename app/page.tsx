import type { Metadata } from 'next'
import { Landing } from '@/components/landing/Landing'
import { currentUser } from '@/lib/auth/session'
import { kindleConfigured } from '@/lib/kindle/send'
import './landing.css'

export const metadata: Metadata = {
  title: 'The Last Ten — bedtime stories for curious children',
  description:
    'Make the last ten minutes of the day the ones they remember: a bedtime story where your child is the hero, with something true to learn.',
}

/**
 * Home, and what lastten.org shows a visitor (issue #17): the mission, and one action.
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
  // F2 AC: a signed-out visitor can reach login from here. Signed in, the action skips it.
  const signedIn = (await currentUser().catch(() => null)) !== null
  return <Landing signedIn={signedIn} justDeleted={params.deleted === '1'} kindle={canSendToKindle()} />
}
