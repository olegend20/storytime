import { after } from 'next/server'
import { supabaseServer } from '@/lib/supabase/server'
import { supabaseService } from '@/lib/supabase/service'
import { parentMessage } from '@/lib/messages'
import type { ErrorBody } from '@/lib/schemas'
import {
  precheckGeneration,
  prepareGeneration,
  productionDeps,
  runGeneration,
  SseChannel,
  SSE_HEADERS,
} from '@/lib/generate'
import {
  finishGenerationRequest,
  generationIdFrom,
  noteGenerationStory,
  startGenerationRequest,
} from '@/lib/generate/requests'
import { ProgressRecorder, discardGenerationProgress, pruneGenerationProgress } from '@/lib/generate/progress'

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
// A 10-minute story on a slow night: p95 target is 90 s, the ceiling is generous. Raised to
// 800 s (Vercel Pro's Fluid ceiling) with the writer's cap and rung 3's shorter retry (issue #32, DECISIONS #177): a write that needs 40,000+ output
// tokens takes over five minutes, and Vercel must not cut it off before the cap matters.
// The project runs Fluid compute (Pro ceiling 800 s); test/unit/deploy-config.test.ts
// ties this number to the cap.
export const maxDuration = 800
/** A comment line this often while the story is silent (see SseChannel.toReadableStream). */
const HEARTBEAT_MS = 15_000

function json(body: ErrorBody, status: number): Response {
  return Response.json(body, { status })
}


export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now()
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
  // The platform kills this function at `maxDuration`; the pipeline plans inside it.
  const deps = { ...productionDeps(), deadlineMs: startedAt + maxDuration * 1000 }
  const familyId = (family as { id: string }).id

  // The cheap checks answer with a real HTTP status, as before: a malformed body, the kill
  // switch, the quota and the budget never cost a model call, and the client shows those
  // messages from the status. Everything that may take a while - the guardrails, the topic,
  // a NEW topic's fact pack (100 s on 2026-10-08) - runs inside the stream, which is opened
  // at once: a phone gives up on a request that has answered nothing for about a minute.
  const early = await precheckGeneration(familyId, body, deps)
  if (!early.ok) return json(early.error, early.status)

  // Issue #59: accepted, so recorded - a page that loses the stream asks how it ended by this id.
  const generationId = generationIdFrom(request)
  const records = generationId ? supabaseService() : null
  const recorded = generationId && records ? await startGenerationRequest(records, generationId, familyId) : false

  const channel = new SseChannel()
  // Issue #82: the story so far, for this page if it loses the stream and comes back.
  const progress = recorded && generationId && records ? new ProgressRecorder(records, generationId, familyId) : null
  if (progress && records) {
    channel.onPush((event) => progress.observe(event))
    void pruneGenerationProgress(records)
  }
  // The story so far is written before the request says it ended, so a page that comes back
  // finds the ending in the snapshot and finishes the story in place (issue #82).
  const finish = async (outcome: Parameters<typeof finishGenerationRequest>[3]) => {
    await progress?.settled()
    if (generationId && records) await finishGenerationRequest(records, generationId, familyId, outcome)
    // Not saved: its text is kept nowhere else, so the snapshot goes now, not in an hour.
    if (progress && records && outcome.status !== 'ready' && outcome.status !== 'flagged') {
      await discardGenerationProgress(records, generationId!, familyId)
    }
  }
  const run = (async () => {
    const prepared = await prepareGeneration(familyId, body, deps)
    if (!prepared.ok) {
      // Inside the stream now: the same message, as the error event the client already
      // handles before the first chapter.
      channel.push({ type: 'error', ...prepared.error })
      channel.close()
      await finish({ status: 'refused', storyId: null, reason: prepared.error.code })
      return null
    }
    if (generationId && records) await noteGenerationStory(records, generationId, familyId, prepared.prepared.storyId)
    const result = await runGeneration(prepared.prepared, channel, deps)
    await finish({ status: result.status, storyId: result.storyId, reason: result.reason ?? null })
    return result
  })().catch(async (err: unknown) => {
    // Anything that threw outside the pipeline's own handling (a database read in the
    // preparation, say): the parent is told it failed and can try again - never left to
    // read an ended stream as "still being made".
    console.error('[generate] unexpected failure:', err)
    channel.push({
      type: 'error',
      code: 'generation_failed',
      message: parentMessage('generation_failed'),
      quota_consumed: false,
      resets_at: null,
    })
    channel.close()
    await finish({ status: 'failed', storyId: null, reason: 'unexpected' })
    return null
  })

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

  // Answered now, not when the first event exists.
  return new Response(channel.toReadableStream(HEARTBEAT_MS), { status: 200, headers: SSE_HEADERS })
}
