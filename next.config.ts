import type { NextConfig } from 'next'

/**
 * Response headers on every route (DECISIONS #149). No CSP for scripts yet: the theme is
 * applied by an inline script before paint and a strict CSP needs nonces through the whole
 * render; frame-ancestors is set here since it does not affect scripts.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  // Only honoured over HTTPS; harmless on localhost. Two years, subdomains, as browsers expect.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
]

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/(.*)', headers: SECURITY_HEADERS }]
  },
  reactStrictMode: true,
  // `next dev` would otherwise append its own block to CLAUDE.md on every start, leaving
  // the tree dirty; the project's working agreements are hand-written.
  agentRules: false,
  // `pnpm test:e2e:real` builds into its own directory, so it never overwrites the mock-mode
  // build `pnpm test:e2e` serves (NEXT_PUBLIC_API_MOCK is inlined at build time).
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Plan docs and the archive are content, not source; keep them out of the build graph.
  outputFileTracingExcludes: { '*': ['./storytime-plan/**', './.archive/**'] },
}

export default nextConfig
