import type { Metadata } from 'next'
import { LandingFooter, LandingHeader } from '@/components/landing/Chrome'
import { COMING_SOON } from '@/lib/landing/copy'
import { isConfirmToken } from '@/lib/waitlist/confirm'
import ConfirmButton from './ConfirmButton'
import '../../landing.css'

/**
 * Issue #95 - the page the confirmation email links to. It only shows a button: confirming
 * happens when a person presses it (POST /api/waitlist/confirm), because mail scanners open
 * links and must not confirm an address for its owner. Nothing here reads the database, so
 * the page says nothing about the token until it is used.
 */

export const metadata: Metadata = {
  title: 'Confirm your place — The Last Ten',
  robots: { index: false, follow: false },
  // The token is in this page's address: never send it on to another site.
  referrer: 'no-referrer',
}

export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = (await searchParams).token
  const token = typeof raw === 'string' && isConfirmToken(raw) ? raw : null

  return (
    <div className="lt">
      <LandingHeader sections={false} />
      <main id="main">
        <section className="lt-hero">
          <p className="st-eyebrow">{COMING_SOON.confirm.eyebrow}</p>
          <ConfirmButton token={token} />
        </section>
      </main>
      <LandingFooter missionHref="/#mission" />
    </div>
  )
}
