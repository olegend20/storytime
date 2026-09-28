import { defineConfig, devices } from '@playwright/test'

/**
 * e2e runs against the app in fixture mode - no live model calls (kickoff rule 3).
 * F9 VT requires a 375x812 mobile viewport with no horizontal scroll.
 *
 * The port is configurable with `E2E_PORT` because several lanes share one machine, and
 * `reuseExistingServer` would otherwise silently attach to another lane's dev server on
 * 3000 and test their app instead of this one. It defaults to 3000, which is the only port
 * in `supabase/config.toml`'s `additional_redirect_urls`, so the magic-link flow gets its
 * full redirect hop there; on any other port the F2 helper verifies the emailed token
 * against /auth/callback directly. See test/e2e/support/login.ts.
 */
const port = Number(process.env.E2E_PORT ?? 3000)
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
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
    command: `pnpm build && pnpm start --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { LIVE_API: '0' },
  },
})
