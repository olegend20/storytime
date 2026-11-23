import type { Metadata } from 'next'
import Link from 'next/link'
import { BRAND } from '@/lib/brand'
import { AMAZON, KINDLE_HELP_OFF, kindleHelpSteps, kindleHelpTroubles, type KindleHelpStep } from '@/lib/kindle/help'
import { kindleFromAddressIfAny } from '@/lib/kindle/send'
import CopyAddress from './CopyAddress'
import '../landing.css'
import './kindle.css'

/**
 * lastten.org/kindle (issue #117): how to set up Send to Kindle, step by step. Public, so the
 * link works from a phone, an email or Amazon's own tab without signing in; it shows nothing
 * about any family. The one fact it reads from the server is the address we send from, which
 * a parent must add to Amazon's approved list.
 *
 * It borrows the landing page's type (`.lt`) but keeps the app's own header and footer: most
 * readers arrive from Settings, signed in, and need the way back to their library.
 */

export const metadata: Metadata = {
  title: `Send to Kindle — ${BRAND.app}`,
  description: 'How to have a StoryTime book sent to your Kindle.',
}

// The sending address is server configuration: read it per request, not at build time.
export const dynamic = 'force-dynamic'

function StepExtras({ step, from }: { step: KindleHelpStep; from: string }) {
  if (step.id === 'find-address') {
    return (
      <p className="kh-links">
        <a href={AMAZON.preferences} target="_blank" rel="noopener noreferrer">
          Open Amazon&rsquo;s Preferences
        </a>
        <a href={AMAZON.help} target="_blank" rel="noopener noreferrer">
          Amazon&rsquo;s own instructions
        </a>
      </p>
    )
  }
  if (step.id === 'approve-sender') {
    return (
      <div className="kh-from">
        <span className="kh-from-label">The address to approve</span>
        <code data-testid="kindle-from">{from}</code>
        <CopyAddress address={from} />
      </div>
    )
  }
  if (step.id === 'save-address') {
    return (
      <p className="kh-links">
        <Link href="/settings">Open Settings</Link>
      </p>
    )
  }
  return (
    <p className="kh-links">
      <Link href="/library">Open your library</Link>
    </p>
  )
}

export default function KindleHelpPage() {
  const from = kindleFromAddressIfAny()
  return (
    <div className="lt">
      <main id="main">
        <section className="lt-hero kh-hero">
          <p className="st-eyebrow">Send to Kindle</p>
          <h1 className="lt-h1">Tonight&rsquo;s book, on a Kindle</h1>
          <p className="lt-lead">
            Keep phones out of the bedroom. Set this up once, at a desk; after that any book is one
            press away.
          </p>
        </section>
        <div className="kh-body">
          {from ? (
            <>
              <ol className="lt-steps">
                {kindleHelpSteps(from).map((step, i) => (
                  <li key={step.id} data-testid={`kindle-step-${step.id}`}>
                    <span className="lt-step-n" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div>
                      <h2>{step.title}</h2>
                      {step.body.map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                      <StepExtras step={step} from={from} />
                    </div>
                  </li>
                ))}
              </ol>
              <section className="kh-trouble" aria-labelledby="kh-trouble-h">
                <h2 id="kh-trouble-h">If the book does not arrive</h2>
                <ul>
                  {kindleHelpTroubles(from).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p>
                  Sending again is safe: a book that arrives twice is just listed twice on the
                  Kindle.
                </p>
              </section>
            </>
          ) : (
            <p className="kh-off" role="status" data-testid="kindle-off">
              {KINDLE_HELP_OFF}
            </p>
          )}
        </div>
      </main>
    </div>
  )
}
