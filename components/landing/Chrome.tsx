import Link from 'next/link'
import { BRAND } from '@/lib/brand'
import { ThemeToggle } from '@/components/ThemeToggle'

/**
 * The header and footer of lastten.org's public pages - the homepage and, while places open a
 * few at a time, the coming-soon page (issue #92) - so the two can never drift apart.
 */
export function LandingHeader({ sections }: { sections: boolean }) {
  return (
    <header className="st-header">
      <div className="st-header-in">
        <Link href="/" className="st-brand" aria-label={`${BRAND.wordmark}, home`}>
          <span className="st-wordmark">{BRAND.wordmark}</span>
          <span className="st-byline">{BRAND.wordmarkByline}</span>
        </Link>
        <nav className="st-nav" aria-label="Main">
          {sections ? (
            <>
              <a href="#mission" className="st-navlink st-hide-sm">
                Our mission
              </a>
              <a href="#how" className="st-navlink st-hide-sm">
                How it works
              </a>
            </>
          ) : null}
          <Link href="/login" className="st-navlink">
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  )
}

export function LandingFooter({ missionHref }: { missionHref: string }) {
  return (
    <footer className="st-footer">
      <div className="st-footer-in">
        <span>
          {BRAND.project} · {BRAND.app} is our bedtime story app.
        </span>
        <span className="st-footer-links">
          <a href={missionHref}>Our mission</a>
          <Link href="/privacy">Privacy</Link>
          <ThemeToggle compact />
        </span>
      </div>
    </footer>
  )
}
