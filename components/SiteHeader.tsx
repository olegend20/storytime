'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Person } from './Icons'
import { ThemeToggle } from './ThemeToggle'
import { BRAND } from '@/lib/brand'

const LINKS = [
  { href: '/new', label: 'Tonight’s book' },
  { href: '/library', label: 'Library' },
]

/**
 * The app's header (issue #17): the name, two places to go, and the account.
 *
 * `data-chrome` marks this as furniture: reading mode hides everything so marked, in CSS,
 * before first paint (see globals.css). The home page draws its own header, so this one steps
 * aside there.
 */
export function SiteHeader() {
  const pathname = usePathname()
  if (pathname === '/') return null
  return (
    <header data-chrome className="st-header">
      <div className="st-header-in">
        <Link href="/" className="st-brand" aria-label={`${BRAND.app}, home`}>
          <span className="st-wordmark">{BRAND.app}</span>
          <span className="st-byline">{BRAND.project}</span>
        </Link>
        <nav className="st-nav" aria-label="Main">
          {LINKS.map((link) => {
            const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`st-navlink${link.href === '/new' ? ' st-hide-sm' : ''}`}
              >
                {link.label}
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
  if (pathname === '/') return null
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
