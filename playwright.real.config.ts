import { defineConfig, devices } from '@playwright/test'

/**
 * `pnpm test:e2e:real` - the app as a parent uses it: real Supabase auth, real `/api/*`,
 * the production guardrail and quota wiring. `pnpm test:e2e` runs lane 4's UI against the
 * mock backend and so never touched any of that - which is how the real library routes and
 * the route's guardrail wiring could both be missing with every e2e test green.
 *
 * ZERO SPEND, by construction: `LIVE_API=0` makes every model call replay a committed fixture
 * or fail, and the flow below only takes paths that make no model call (an L1 refusal is
 * deterministic). Needs `supabase start`.
 */
const PORT = Number(process.env.E2E_REAL_PORT ?? 3100)
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './test/e2e-real',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Its own build dir: `next build` inlines NEXT_PUBLIC_API_MOCK, so the mock and real builds
    // must not overwrite each other.
    command: `pnpm build && pnpm start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    env: {
      LIVE_API: '0',
      UI_MOCK_API: '0',
      NEXT_PUBLIC_API_MOCK: '0',
      NEXT_DIST_DIR: '.next-real',
    },
  },
})
