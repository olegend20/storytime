import { installSupabaseLogSink, installedLogSink } from './sink'

/**
 * Persist model-call costs from a CLI or test run, not just from the Next.js server.
 *
 * `instrumentation.ts` installs the Supabase sink at server boot, which covers the deployed
 * app — but `tsx eval/run-eval.ts` and vitest never boot Next, so every call they made went
 * to the in-memory sink and was discarded. After roughly $10 of real calibration, fact-pack
 * and fixture spend, `generation_logs` held **one row worth $0.0005** and the admin dashboard
 * would have shown ~zero. §1.6 says "measure everything"; this is where that was leaking.
 *
 * Best-effort on purpose: a CLI run must still work with no database (fixture mode, CI, a
 * laptop without Docker), so a missing service-role key or an unreachable Supabase is a
 * warning rather than a failure. It returns whether persistence is actually on, so a caller
 * can say so in its output instead of leaving the operator to assume.
 */
export function installCliCostLogging(): { persisting: boolean; reason: string } {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    return {
      persisting: false,
      reason:
        'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set - costs are reported by this command ' +
        'but NOT written to generation_logs, so /admin will not see this run',
    }
  }
  if (key.startsWith('test-') || key.startsWith('ci-')) {
    return { persisting: false, reason: 'placeholder Supabase key - costs not persisted' }
  }

  try {
    installSupabaseLogSink()
    return { persisting: installedLogSink() !== null, reason: 'writing to generation_logs' }
  } catch (err) {
    return {
      persisting: false,
      reason: `could not install the Supabase log sink: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
