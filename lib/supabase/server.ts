import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { serverEnv } from '@/lib/env'

/** Request-scoped client that respects RLS as the logged-in user. */
export async function supabaseServer() {
  const env = serverEnv()
  const cookieStore = await cookies()
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options)
        } catch {
          // Called from a Server Component, where cookies are read-only. Middleware
          // refreshes the session instead, so this is safe to ignore.
        }
      },
    },
  })
}
