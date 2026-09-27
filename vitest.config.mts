import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Native tsconfig path resolution: replaces the vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Model-calling tests replay fixtures by default; live calls need LIVE_API=1.
    testTimeout: process.env.LIVE_API === '1' ? 180_000 : 20_000,
    hookTimeout: 60_000,
  },
})
