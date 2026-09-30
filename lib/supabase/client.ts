'use client'

import { createBrowserClient } from '@supabase/ssr'

/**
 * Browser client. Reads the NEXT_PUBLIC_ mirrors rather than lib/env.ts, which is
 * server-only (it validates secrets that must never reach the bundle).
 */
export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env.local.',
    )
  }
  return createBrowserClient(url, key)
}
