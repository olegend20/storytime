import { describe, expect, it } from 'vitest'
import { canonicalUrl } from '@/lib/http/canonical'

/** Issue #101: www.lastten.org redirects to lastten.org, so sign-in has one origin. */
describe('canonicalUrl', () => {
  const site = 'https://lastten.org'

  it('moves www to the bare domain, keeping the path and query', () => {
    expect(canonicalUrl('https://www.lastten.org/login?next=%2Flibrary', 'www.lastten.org', site)).toBe(
      'https://lastten.org/login?next=%2Flibrary',
    )
    expect(canonicalUrl('https://www.lastten.org/', 'WWW.LastTen.org', site)).toBe('https://lastten.org/')
  })

  it.each([
    ['lastten.org', site],
    ['storytime-abc.vercel.app', site],
    ['www.evil.example', site],
    ['www.lastten.org', undefined],
    ['www.lastten.org', 'not a url'],
    [null, site],
  ])('leaves %s alone (SITE_URL %s)', (host, siteUrl) => {
    expect(canonicalUrl('https://x/login', host, siteUrl)).toBeNull()
  })
})
