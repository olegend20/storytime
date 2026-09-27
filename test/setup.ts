/**
 * Global test setup. Kickoff rule 3: tests must never reach the live API unless
 * LIVE_API=1 is set explicitly.
 */
if (process.env.LIVE_API !== '1' && process.env.LIVE_API !== 'true') {
  // A dummy key so the SDK constructor and env validation succeed in replay mode.
  // callModel() short-circuits to fixtures before any network call is attempted.
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-replay-only'
}
process.env.SUPABASE_URL ??= 'http://127.0.0.1:54321'
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key'

/**
 * Tests that fabricate a fixture write into a temp directory, so `test/fixtures/model/`
 * stays reserved for fixtures recorded from real API responses (kickoff rule 3).
 * A test that needs a *recorded* fixture unsets FIXTURE_DIR for itself.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.FIXTURE_DIR ??= mkdtempSync(join(tmpdir(), 'storytime-fixtures-'))
