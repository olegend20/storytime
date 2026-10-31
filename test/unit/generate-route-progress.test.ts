import { describe, expect, it, vi } from 'vitest'

/**
 * VT-RC8 (issue #82): the route keeps the story so far for a request that has a generation id,
 * and only for one. Keeping it never changes the stream the page receives, even when every
 * database write fails.
 */

type Call = { table: string; op: string; args: unknown[] }
const db = vi.hoisted(() => ({ calls: [] as Call[], fail: false }))

/** A Supabase client stand-in: every chain resolves, and each table operation is recorded. */
function fakeService() {
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            const result = db.fail ? { data: null, error: { message: 'database down' } } : { data: null, error: null }
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          return (...args: unknown[]) => {
            if (['insert', 'update', 'upsert', 'delete'].includes(String(prop))) db.calls.push({ table, op: String(prop), args })
            return chain(table)
          }
        },
      },
    )
  return { from: (table: string) => chain(table) }
}

vi.mock('next/server', () => ({ after: () => {} }))
vi.mock('@/lib/supabase/server', () => ({
  supabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { id: 'family-1' } }) }) }),
      }),
    }),
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ supabaseService: () => fakeService() }))
vi.mock('@/lib/generate', async (orig) => ({
  ...(await orig<typeof import('@/lib/generate')>()),
  precheckGeneration: async () => ({ ok: true }),
  prepareGeneration: async () => ({
    ok: false,
    status: 422,
    error: { code: 'topic_refused', message: 'x', quota_consumed: false, resets_at: null },
  }),
}))

const { POST } = await import('@/app/api/stories/generate/route')

const GEN = 'a5f0c3d2-1b4e-4c8a-9f6d-2e7b8c9d0a1b'
async function generate(withId: boolean): Promise<string> {
  const res = await POST(
    new Request('http://localhost/api/stories/generate', {
      method: 'POST',
      body: '{}',
      headers: withId ? { 'x-generation-id': GEN } : {},
    }),
  )
  return res.text()
}

describe('VT-RC8: the route keeps the story so far (issue #82)', () => {
  it('for a request with a generation id: every event reaches the snapshot, written before the request ends', async () => {
    db.calls = []
    const text = await generate(true)
    await vi.waitFor(() => expect(db.calls.some((c) => c.table === 'generation_requests' && c.op === 'update')).toBe(true))
    const upserts = db.calls.filter((c) => c.table === 'generation_progress' && c.op === 'upsert')
    expect(upserts.length).toBeGreaterThan(0)
    const row = upserts.at(-1)!.args[0] as { generation_id: string; family_id: string; version: number; events: { type: string }[] }
    expect(row).toMatchObject({ generation_id: GEN, family_id: 'family-1' })
    expect(row.events.at(-1)).toMatchObject({ type: 'error', code: 'topic_refused' })
    expect(text).toContain('"code":"topic_refused"')
    // The snapshot is written before the request says it ended.
    const progressAt = db.calls.lastIndexOf(upserts.at(-1)!)
    const finishedAt = db.calls.findIndex((c) => c.table === 'generation_requests' && c.op === 'update')
    expect(progressAt).toBeLessThan(finishedAt)
    // Old snapshots are pruned as the request starts.
    expect(db.calls.some((c) => c.table === 'generation_progress' && c.op === 'delete')).toBe(true)
  })

  it('without a generation id (an older page): nothing is kept', async () => {
    db.calls = []
    await generate(false)
    expect(db.calls.filter((c) => c.table === 'generation_progress')).toEqual([])
  })

  it('a database that fails every write leaves the stream byte for byte the same', async () => {
    db.fail = false
    const healthy = await generate(true)
    db.fail = true
    try {
      const failing = await generate(true)
      expect(failing).toBe(healthy)
    } finally {
      db.fail = false
    }
  })
})
