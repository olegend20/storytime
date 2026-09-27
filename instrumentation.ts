/**
 * Next.js calls `register()` once per server process, before any route runs.
 *
 * F8: this is where `callModel()`'s default log sink is swapped from the in-memory one to
 * the Supabase-backed one, so every model call in the deployed app writes a
 * `generation_logs` row. Doing it here rather than in a route means no call site can forget.
 */
export async function register(): Promise<void> {
  // The Edge runtime has no service-role client; only the Node.js server logs costs.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { installSupabaseLogSink } = await import('@/lib/costs/sink')
  installSupabaseLogSink()
}
