import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'
import { QuotaResponse } from '@/lib/schemas/api'
import { generationAvailable } from '@/lib/limits/guard'
import { quotaStatus } from '@/lib/limits/quota'

/**
 * GET /api/quota — the "2 of 3 stories left today" indicator (F10), and the flag that lets
 * the new-story form disable itself when generation is paused.
 *
 * Reads only. This never moves the counter: quota is consumed after a successful `stories`
 * insert, by `consumeQuota()` in the generation route (F8 AC).
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await supabaseServer()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) {
    return NextResponse.json({ code: 'unauthenticated', message: 'Please sign in.' }, { status: 401 })
  }

  // RLS restricts this to the caller's own family.
  const { data: family, error } = await supabase
    .from('families')
    .select('id, timezone')
    .is('deleted_at', null)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ code: 'server_error', message: 'Could not read your family.' }, { status: 500 })
  }
  if (!family) {
    return NextResponse.json({ code: 'no_family', message: 'No family yet.' }, { status: 404 })
  }

  const [quota, availability] = await Promise.all([
    quotaStatus({ familyId: family.id as string, timezone: family.timezone as string }),
    generationAvailable(),
  ])

  const body: QuotaResponse = {
    used: quota.used,
    limit: quota.limit,
    ...(quota.unlimited ? { unlimited: true } : {}),
    resets_at: quota.resetsAt,
    generation_enabled: availability.enabled,
  }

  return NextResponse.json(QuotaResponse.parse(body), {
    headers: { 'cache-control': 'no-store' },
  })
}
