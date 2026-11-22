'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Person } from './Icons'
import { ThemeToggle } from './ThemeToggle'
import { BRAND } from '@/lib/brand'

/** `short` is what a phone shows: both links must fit beside the name at 320px. */
const LINKS = [
  { href: '/new', label: 'Tonight’s book', short: 'Tonight' },
  { href: '/library', label: 'Library', short: 'Library' },
]

/**
 * Pages that draw the lastten.org landing header and footer themselves (`LandingHeader`,
 * `LandingFooter`). The app's own header and footer step aside there, or the page shows two
 * of each.
 */
const OWN_CHROME = new Set(['/', '/feedback', '/waitlist/confirm'])

export function drawsOwnChrome(pathname: string | null): boolean {
  return OWN_CHROME.has(pathname ?? '')
}

/**
 * The app's header (issue #17): the name, two places to go, and the account.
 *
 * `data-chrome` marks this as furniture: reading mode hides everything so marked, in CSS,
 * before first paint (see globals.css). Pages with their own landing header (`drawsOwnChrome`)
 * get none of this.
 */
export function SiteHeader() {
  const pathname = usePathname()
  if (drawsOwnChrome(pathname)) return null
  return <AppHeader />
}

export function AppHeader() {
  const pathname = usePathname()
  return (
    <header data-chrome className="st-header st-header-app">
      <div className="st-header-in">
        <Link href="/" className="st-brand" aria-label={`${BRAND.app}, home`}>
          <span className="st-wordmark">{BRAND.app}</span>
          <span className="st-byline">{BRAND.project}</span>
        </Link>
        <nav className="st-nav" aria-label="Main">
          {LINKS.map((link) => {
            const active =
              pathname === link.href ||
              pathname.startsWith(`${link.href}/`) ||
              // The creator lives at three addresses.
              (link.href === '/new' && (pathname === '/' || pathname === '/dashboard'))
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className="st-navlink"
                aria-label={link.label}
              >
                <span className="st-hide-sm">{link.label}</span>
                <span className="st-show-sm">{link.short}</span>
              </Link>
            )
          })}
          <Link
            href="/settings"
            className="st-avatar"
            aria-label="Account and settings"
            aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
          >
            <span>
              <Person width={17} height={17} />
            </span>
          </Link>
        </nav>
      </div>
    </header>
  )
}

/** The quiet end of every app page: the line we stand behind, two links, and the theme. */
export function SiteFooter() {
  const pathname = usePathname()
  if (drawsOwnChrome(pathname)) return null
  return <AppFooter />
}

export function AppFooter() {
  return (
    <footer data-chrome className="st-footer">
      <div className="st-footer-in">
        <span>{BRAND.footer}</span>
        <span className="st-footer-links">
          <Link href="/#mission">Our mission</Link>
          <Link href="/privacy">Privacy</Link>
          <ThemeToggle compact />
        </span>
      </div>
    </footer>
  )
}
