import { afterAll, describe, expect, it } from 'vitest'
import { handleFeedback } from '@/lib/feedback/handlers'
import { anon, applyTestSupabaseEnv, dbReachable, service, SKIP_REASON } from '../helpers/db'

/**
 * Tester feedback against the local Supabase (VT-FB3): the route body stores a row in the
 * real table, and the public (anon) key can neither read nor write it.
 */

applyTestSupabaseEnv()
const reachable = await dbReachable()
if (!reachable) console.warn(`[skip] test/int/feedback.test.ts - ${SKIP_REASON}`)

const RUN = `feedback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

afterAll(async () => {
  if (!reachable) return
  await service().from('feedback').delete().eq('anything_else', RUN)
})

describe.runIf(reachable)('feedback table (VT-FB3)', () => {
  it('a submission through the route body lands in the table', async () => {
    const res = await handleFeedback(
      { service: service() },
      { enjoyment: 'loved', reading_on: ['phone', 'ereader'], anything_else: RUN, email: 'Tester@Example.com' },
    )
    expect(res.status).toBe(200)
    const { data, error } = await service().from('feedback').select('*').eq('anything_else', RUN)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ enjoyment: 'loved', reading_on: ['phone', 'ereader'], email: 'tester@example.com' })
  })

  it('the anon key cannot read anyone’s feedback', async () => {
    const { data, error } = await anon().from('feedback').select('*').eq('anything_else', RUN)
    // No grant: PostgREST refuses outright, or (with grants but RLS) returns nothing.
    expect(error !== null || (data ?? []).length === 0).toBe(true)
  })

  it('the anon key cannot write feedback directly, around the route', async () => {
    const { error } = await anon().from('feedback').insert({ enjoyment: 'loved', anything_else: `${RUN}-direct` })
    expect(error).not.toBeNull()
  })

  it('the database itself refuses a value off the list', async () => {
    const { error } = await service().from('feedback').insert({ enjoyment: 'amazing', anything_else: RUN })
    expect(error).not.toBeNull()
  })
})
