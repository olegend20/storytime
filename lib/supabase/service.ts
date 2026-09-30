import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { serverEnv } from '@/lib/env'

/**
 * Service-role client: BYPASSES RLS. Use only for writes that must not be
 * client-reachable - generation_logs, guardrail_events, fact_packs, daily_usage.
 * Never expose this to the browser and never use it to serve family data.
 */
let cached: SupabaseClient | null = null

export function supabaseService(): SupabaseClient {
  if (cached) return cached
  const env = serverEnv()
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
