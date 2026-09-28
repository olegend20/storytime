'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ThemeToggle } from './ThemeToggle'

const LINKS = [
  { href: '/new', label: 'New story' },
  { href: '/library', label: 'Library' },
]

/**
 * `data-chrome` marks this as furniture: reading mode hides everything so marked, in CSS,
 * before first paint (see globals.css).
 */
export function SiteHeader() {
  const pathname = usePathname()
  return (
    <header data-chrome className="border-b border-line bg-raised">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link
          href="/"
          className="mr-auto text-lg font-semibold no-underline"
          style={{ color: 'var(--fg)' }}
        >
          StoryTime
        </Link>
        <nav aria-label="Main">
          <ul className="flex list-none items-center gap-1 p-0 m-0">
            {LINKS.map((link) => {
              const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className="tap inline-flex items-center rounded-lg px-3 py-2 text-sm no-underline"
                    style={{
                      color: active ? 'var(--accent-fg)' : 'var(--fg)',
                      background: active ? 'var(--accent)' : 'transparent',
                      fontWeight: active ? 650 : 500,
                    }}
                  >
                    {link.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
        <ThemeToggle compact />
      </div>
    </header>
  )
}
