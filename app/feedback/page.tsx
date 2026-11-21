import type { Metadata } from 'next'
import { LandingFooter, LandingHeader } from '@/components/landing/Chrome'
import { BRAND } from '@/lib/brand'
import { FEEDBACK_COPY } from '@/lib/feedback/questions'
import FeedbackForm from './FeedbackForm'
import '../landing.css'
import './feedback.css'

/**
 * lastten.org/feedback - the link in the thank-you note to testers (owner request 2026-11-20).
 * Public, so a tester can answer from the email without signing in. Answers go to
 * POST /api/feedback; nothing on this page reads the database.
 */

export const metadata: Metadata = {
  title: `Feedback — ${BRAND.wordmark}`,
  description: 'Tell us how StoryTime has gone for your family.',
  robots: { index: false, follow: false },
}

export default function FeedbackPage() {
  return (
    <div className="lt">
      <LandingHeader sections={false} />
      <main id="main">
        <section className="lt-hero fb-hero">
          <p className="st-eyebrow">{FEEDBACK_COPY.eyebrow}</p>
          <FeedbackForm />
        </section>
      </main>
      <LandingFooter missionHref="/#mission" />
    </div>
  )
}
