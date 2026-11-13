/**
 * One origin for the site (issue #101). The sign-in email's link always opens on `site_url`
 * (lastten.org), and the browser check that signs a parent in lives in a cookie on the origin
 * they asked from. A parent on www.lastten.org would ask there and be refused here, so www
 * redirects to the bare domain before anything else, path and query kept.
 *
 * Only `www.` + SITE_URL's own host moves; with SITE_URL unset (dev, tests) nothing does.
 */
export function canonicalUrl(requestUrl: string, host: string | null, siteUrl: string | undefined): string | null {
  if (!siteUrl || !host) return null
  let site: URL
  try {
    site = new URL(siteUrl)
  } catch {
    return null
  }
  if (host.toLowerCase() !== `www.${site.host.toLowerCase()}`) return null
  const from = new URL(requestUrl)
  return `${site.origin}${from.pathname}${from.search}`
}
