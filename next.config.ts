import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
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
