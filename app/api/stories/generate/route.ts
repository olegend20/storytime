import { after } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'
import { parentMessage } from '@/lib/messages'
import type { ErrorBody } from '@/lib/schemas'
import {
  prepareGeneration,
  productionDeps,
  runGeneration,
  SseChannel,
  SSE_HEADERS,
  type PreStreamFailure,
} from '@/lib/generate'

/**
 * POST /api/stories/generate - the SSE endpoint in `lib/schemas/api.ts` (F6).
 *
 * The contract has two failure shapes and this route is where they diverge:
 *
 *   - **before the stream opens**: a JSON body with the real status (400/422/429/502/503).
 *   - **after it opens**: an `error` event on the already-committed 200, carrying
 *     `quota_consumed` so the UI can honestly say "this didn't use one of your stories".
 *
 * `channel.waitForOpen()` is the pivot: it resolves once the first event exists (so we are
 * committed to a 200 stream) and rejects when the run failed with nothing yet written.
 */

// `lib/prompts.ts` reads prompts/*.md from disk and the pipeline uses node:crypto.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A 10-minute story on a slow night: p95 target is 90 s, the ceiling is generous.
export const maxDuration = 300

function json(body: ErrorBody, status: number): Response {
  return Response.json(body, { status })
}

function isPreStreamFailure(value: unknown): value is PreStreamFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    'status' in value &&
    typeof (value as { status: unknown }).status === 'number'
  )
}

export async function POST(request: Request): Promise<Response> {
  const supabase = await supabaseServer()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return json(
      {
        code: 'invalid_request',
        message: parentMessage('invalid_request'),
        quota_consumed: false,
        resets_at: null,
      },
      401,
    )
  }

  // Read the family through the RLS client: a user can only ever see their own.
  const { data: family } = await supabase
    .from('families')
    .select('id')
    .eq('owner_user_id', user.id)
    .is('deleted_at', null)
    .maybeSingle()

  if (!family) {
    return json(
      {
        code: 'invalid_request',
        message: parentMessage('invalid_request'),
        quota_consumed: false,
        resets_at: null,
      },
      400,
    )
  }

  const body = await request.json().catch(() => null)
  // Quota, budget cap, L1/L2 and L4. Without these the pipeline falls back to stubs that
  // allow everything (lib/generate/deps.ts) - this line is what makes the guardrails real.
  const deps = productionDeps()
  const prepared = await prepareGeneration((family as { id: string }).id, body, deps)
  if (!prepared.ok) return json(prepared.error, prepared.status)

  const channel = new SseChannel()
  const run = runGeneration(prepared.prepared, channel, deps).catch(() => null)

  // The bible update is started after `done` and must outlive the streamed response.
  try {
    after(async () => {
      const result = await run
      if (result?.bibleUpdate) await result.bibleUpdate
    })
  } catch {
    // `after` is unavailable outside a request scope (e.g. a direct unit call). The update
    // still runs; it just has no lifetime guarantee here.
  }

  try {
    await channel.waitForOpen()
  } catch (err) {
    if (isPreStreamFailure(err)) return json(err.error, err.status)
    return json(
      {
        code: 'generation_failed',
        message: parentMessage('generation_failed'),
        quota_consumed: false,
        resets_at: null,
      },
      502,
    )
  }

  return new Response(channel.toReadableStream(), { status: 200, headers: SSE_HEADERS })
}
