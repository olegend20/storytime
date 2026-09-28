import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Native tsconfig path resolution: replaces the vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Model-calling tests replay fixtures by default; live calls need LIVE_API=1.
    // A live fact-pack build runs a web-search tool loop and can take several minutes;
    // 180s cut four of them off mid-flight and left stale `building` locks behind.
    testTimeout: process.env.LIVE_API === '1' ? 900_000 : 20_000,
    // A live corpus run makes ~160 classifier calls inside one beforeAll; 60s is nowhere
    // near enough for that, and the timeout looked like a classifier failure.
    hookTimeout: process.env.LIVE_API === '1' ? 900_000 : 60_000,
  },
})
