import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Plan docs and the archive are content, not source; keep them out of the build graph.
  outputFileTracingExcludes: { '*': ['./storytime-plan/**', './.archive/**'] },
}

export default nextConfig
