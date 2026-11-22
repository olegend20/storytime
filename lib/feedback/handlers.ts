import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, apiOk } from '@/lib/http/responses'
import { FEEDBACK_COPY, MAX_NAME, MAX_TEXT } from './questions'
import { parseFeedback, type FeedbackRow } from './validate'

/**
 * POST /api/feedback, kept out of `app/` so the tests can drive it with a real or fake client.
 *
 * Public: testers may not be signed in, and the link is sent by email. The table is service
 * role only (RLS on, no policies, no grants to anon or authenticated), so the route is the
 * only way in and nobody can read anyone's answers through the public API. The proxy's IP
 * rate limit covers it like every `/api/*` route.
 *
 * `website` is the same honeypot as the waitlist form: bots fill it, people never see it. Such
 * a request gets the normal answer and is stored nowhere.
 */

export interface FeedbackDeps {
  service: SupabaseClient
}

export async function insertFeedback(db: SupabaseClient, row: FeedbackRow): Promise<void> {
  const { error } = await db.from('feedback').insert(row)
  if (error) throw new Error(`feedback insert failed: ${error.message}`)
}

export async function handleFeedback(deps: FeedbackDeps, body: unknown): Promise<Response> {
  const input = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null
  if (typeof input?.website === 'string' && input.website.trim() !== '') return apiOk({ ok: true })

  const parsed = parseFeedback(body)
  if (!parsed.ok) {
    const message =
      parsed.reason === 'empty'
        ? FEEDBACK_COPY.empty
        : parsed.reason === 'bad_email'
          ? FEEDBACK_COPY.badEmail
          : parsed.reason === 'too_long'
            ? `That answer is a little long. Please keep it under ${parsed.field === 'name' ? MAX_NAME : MAX_TEXT} characters.`
            : 'Please choose one of the options shown.'
    return apiError('invalid_request', message, { field: parsed.field })
  }

  try {
    await insertFeedback(deps.service, parsed.row)
  } catch (cause) {
    console.error('[feedback] insert failed', cause)
    return apiError('server_error', FEEDBACK_COPY.error)
  }
  return apiOk({ ok: true })
}
