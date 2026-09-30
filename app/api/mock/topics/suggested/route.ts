import { SuggestedTopicsResponse } from '@/lib/schemas'
import { json, withSession } from '@/lib/mock/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Mock `GET /api/topics/suggested`.
 *
 * Returns three warm topics on purpose, not eight: early in the product's life there are few
 * fact packs, and the UI has to reach eight chips anyway (see `lib/client/topics.ts`). A mock
 * that always returned a full row would hide that.
 */
export async function GET(req: Request): Promise<Response> {
  return withSession(req, () =>
    json(
      SuggestedTopicsResponse.parse({
        topics: [
          { label: 'The history of LEGO', topic_key: 'history-of-lego', warm: true },
          { label: 'Sharks', topic_key: 'sharks', warm: true },
          { label: 'The history of video games', topic_key: 'history-of-video-games', warm: true },
        ],
      }),
    ),
  )
}
