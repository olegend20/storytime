import { MOCK_CHILDREN } from '@/lib/mock/children'
import { json, withSession } from '@/lib/mock/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Mock `GET /api/children` (F3, lane 1). Provisional shape - see `lib/client/types.ts`. */
export async function GET(req: Request): Promise<Response> {
  return withSession(req, () => json({ children: MOCK_CHILDREN }))
}
