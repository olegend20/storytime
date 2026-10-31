import { beforeEach, describe, expect, it, vi } from 'vitest'

/** VT-RC3 (issue #82): the progress endpoint - signed in, the family's own request, `after` read safely. */

const mocks = vi.hoisted(() => ({
  family: { family: { id: 'family-1' } } as { family: { id: string } } | null,
  read: vi.fn(),
}))
vi.mock('@/lib/auth/session', () => ({ currentFamilyIfAny: async () => mocks.family }))
vi.mock('@/lib/supabase/service', () => ({ supabaseService: () => ({}) }))
vi.mock('@/lib/generate/progress', () => ({ readGenerationProgress: mocks.read }))

const { GET } = await import('@/app/api/stories/generate/[id]/progress/route')
const GEN = 'a5f0c3d2-1b4e-4c8a-9f6d-2e7b8c9d0a1b'
const call = (query: string) =>
  GET(new Request(`http://localhost/api/stories/generate/${GEN}/progress${query}`), { params: Promise.resolve({ id: GEN }) })

beforeEach(() => {
  mocks.family = { family: { id: 'family-1' } }
  mocks.read.mockReset()
})

describe('GET /api/stories/generate/:id/progress', () => {
  it('reads the signed-in family\'s request with the page\'s version', async () => {
    mocks.read.mockResolvedValue({ status: 'writing', story_id: null, version: 4, events: [] })
    const res = await call('?after=3')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'writing', story_id: null, version: 4, events: [] })
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), 'family-1', GEN, 3)
  })

  it('a missing or odd `after` is read as 0: the page gets the whole story so far', async () => {
    mocks.read.mockResolvedValue({ status: 'writing', story_id: null, version: 1, events: [] })
    for (const q of ['', '?after=-2', '?after=1.5', '?after=abc']) {
      await call(q)
      expect(mocks.read.mock.calls.at(-1)?.[3]).toBe(0)
    }
  })

  it('another family\'s request, or none, is a 404; signed out is a 401', async () => {
    mocks.read.mockResolvedValue(null)
    expect((await call('')).status).toBe(404)
    mocks.family = null
    expect((await call('')).status).toBe(401)
  })

  it('a read failure is a 500 the page treats as "ask again"', async () => {
    mocks.read.mockRejectedValue(new Error('db down'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await call('')).status).toBe(500)
    err.mockRestore()
  })
})
