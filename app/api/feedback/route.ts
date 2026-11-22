import type { NextRequest } from 'next/server'
import { handleFeedback } from '@/lib/feedback/handlers'
import { apiError, readJsonBody } from '@/lib/http/responses'
import { supabaseService } from '@/lib/supabase/service'

/**
 * Tester feedback from /feedback.
 *
 * POST /api/feedback { enjoyment?, stories_read?, loved?, confusing?, reading_on?, wish?,
 *   keep_using?, anything_else?, name?, email?, website? } -> { ok: true }
 *
 * Public and rate-limited per IP by the proxy. See lib/feedback/handlers.ts.
 */
export async function POST(request: NextRequest) {
  const body = await readJsonBody(request)
  if (body === undefined) return apiError('invalid_request', 'We could not read that request.')
  return handleFeedback({ service: supabaseService() }, body)
}
