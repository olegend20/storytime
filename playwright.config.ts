import { defineConfig, devices } from '@playwright/test'

/**
 * e2e runs against the app in fixture mode - no live model calls (kickoff rule 3).
 * F9 VT requires a 375x812 mobile viewport with no horizontal scroll.
 */
/**
 * The port is configurable because lanes share one machine.
 *
 * `reuseExistingServer` is on outside CI, so two lanes running `pnpm test:e2e` at the same time
 * both claim :3000 — the second silently tests the first lane's build, and runs hang. Set
 * `E2E_PORT` (or `E2E_BASE_URL`) per worktree to keep them apart.
 */
const PORT = Number(process.env.E2E_PORT ?? 3000)
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'], viewport: { width: 375, height: 812 } },
    },
  ],
  webServer: {
    command: `pnpm build && pnpm start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    /**
     * `next start` does not always exit on SIGTERM, and Playwright then waits on it forever - the
     * whole suite passes and the command never returns. Force the kill after 5s.
     */
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    env: {
      LIVE_API: '0',
      /**
       * Lane 4's mock backend serves `/api/mock/*` by replaying recorded stories, so e2e makes
       * zero model calls while lane 2 builds the real `/api/*`. Both vars are needed: the
       * `NEXT_PUBLIC_` one is inlined into the client bundle at build time and chooses the base
       * path, the other switches the routes on at all (they 404 without it).
       */
      UI_MOCK_API: '1',
      NEXT_PUBLIC_API_MOCK: '1',
    },
  },
})
