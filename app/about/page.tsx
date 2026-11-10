import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Landing } from '@/components/landing/Landing'
import { canSendToKindle } from '@/lib/kindle/send'
import { waitlistEnabled } from '@/lib/waitlist/mode'
import '../landing.css'

export const metadata: Metadata = {
  title: 'About — The Last Ten',
  description:
    'Make the last ten minutes of the day the ones they remember: a bedtime story where your child is the hero, with something true to learn.',
}

/** As on the homepage: a page with nothing to configure must render with an incomplete env. */

/**
 * Issue #92: the full homepage, kept at /about while lastten.org is a coming-soon page. Its
 * buttons join the waitlist. Once the waitlist is off this page *is* the homepage, so /about
 * sends visitors there rather than keep two copies.
 */
export default function AboutPage() {
  if (!waitlistEnabled()) redirect('/')
  return <Landing justDeleted={false} kindle={canSendToKindle()} waitlist />
}
