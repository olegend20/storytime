import { z } from 'zod'
import { json, quotaLimit, resetState, withSession } from '@/lib/mock/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Test-only control surface for the mock backend. Exists so e2e can ASSERT the ACs rather
 * than assume them:
 *  - `model_calls` is the stand-in for a `generation_logs` count, which is how F9's
 *    "opening a saved story makes zero model calls" is verified.
 *  - `quota_used` can be pushed to the limit, which is how F10's "button disabled with the
 *    reset time shown" is verified without generating three stories.
 *
 * Reachable only when `UI_MOCK_API=1` (`withSession` 404s otherwise), so it cannot exist in a
 * deployment that talks to lane 2's real API.
 */

export async function GET(req: Request): Promise<Response> {
  return withSession(req, ({ sid, state }) =>
    json({
      sid,
      model_calls: state.modelCalls,
      quota_used: state.quotaUsed,
      quota_limit: quotaLimit(),
      generation_enabled: state.generationEnabled,
      story_ids: [...state.stories.keys()],
    }),
  )
}

const Patch = z.object({
  reset: z.boolean().optional(),
  quota_used: z.number().int().min(0).optional(),
  generation_enabled: z.boolean().optional(),
  model_calls: z.number().int().min(0).optional(),
})

export async function POST(req: Request): Promise<Response> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    raw = {}
  }
  const patch = Patch.safeParse(raw)
  return withSession(req, ({ sid, state }) => {
    if (!patch.success) return json({ code: 'invalid_request' }, { status: 400 })
    const target = patch.data.reset ? resetState(sid) : state
    if (patch.data.quota_used !== undefined) target.quotaUsed = patch.data.quota_used
    if (patch.data.generation_enabled !== undefined) {
      target.generationEnabled = patch.data.generation_enabled
    }
    if (patch.data.model_calls !== undefined) target.modelCalls = patch.data.model_calls
    return json({
      sid,
      model_calls: target.modelCalls,
      quota_used: target.quotaUsed,
      quota_limit: quotaLimit(),
      generation_enabled: target.generationEnabled,
      story_ids: [...target.stories.keys()],
    })
  })
}
