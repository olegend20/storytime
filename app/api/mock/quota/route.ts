import { QuotaResponse } from '@/lib/schemas'
import { json, quotaLimit, resetsAt, withSession } from '@/lib/mock/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Mock `GET /api/quota` - `QuotaResponse` in `lib/schemas/api.ts`. */
export async function GET(req: Request): Promise<Response> {
  return withSession(req, ({ state }) =>
    json(
      QuotaResponse.parse({
        used: state.quotaUsed,
        limit: quotaLimit(),
        resets_at: resetsAt(),
        generation_enabled: state.generationEnabled,
      }),
    ),
  )
}
