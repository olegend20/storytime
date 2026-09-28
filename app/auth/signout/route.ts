import { NextResponse, type NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'

/**
 * POST-only sign out (F2). A GET would let any page log the parent out with an
 * `<img src>`, which is a CSRF, not a feature.
 */
export async function POST(request: NextRequest) {
  const db = await supabaseServer()
  await db.auth.signOut()
  const home = new URL('/', request.nextUrl.origin)
  return NextResponse.redirect(home, { status: 303 })
}
