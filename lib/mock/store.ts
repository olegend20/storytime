import { DAILY_STORY_LIMIT } from '@/lib/schemas'
import { LibraryStory } from '@/lib/client/types'
import fixtures from './fixture-stories.json'

/**
 * In-memory backend for lane 4's mock API.
 *
 * Why this exists: lane 2 is building `/api/stories/generate` in parallel, and e2e must make
 * zero model calls either way (kickoff rule 3). So the UI is built against
 * `lib/schemas/api.ts` and served, in e2e and in local dev, by a replay of a recorded stream.
 * Real routes live at `/api/*` and stay lane 2's; these live at `/api/mock/*` so the two can
 * never collide on merge.
 *
 * State is keyed by a session cookie, not global, because Playwright runs tests in parallel
 * against one server: each browser context gets its own cookie and therefore its own quota
 * and its own library. Without that, two tests racing on quota would flake.
 */

export const MOCK_SESSION_COOKIE = 'st_mock_sid'

/** Mock routes 404 unless explicitly switched on, so they cannot ship live by accident. */
export function mockEnabled(): boolean {
  return process.env.UI_MOCK_API === '1'
}

export interface MockState {
  stories: Map<string, LibraryStory>
  quotaUsed: number
  /**
   * Stand-in for `generation_logs`: how many writing-model calls this session has caused.
   * F9's AC is "opening a saved story makes zero model calls", and an AC that is asserted is
   * worth more than one that is assumed - e2e reads this counter before and after an open.
   */
  modelCalls: number
  generationEnabled: boolean
  /** Stories streamed so far, so a second generation returns a different story. */
  generated: number
}

const sessions = new Map<string, MockState>()

/** The three stories a fixture family already has; the rest are what generation streams. */
export const LIBRARY_FIXTURE_COUNT = 3

function parseFixtures(): LibraryStory[] {
  return fixtures.stories.map((s) => LibraryStory.parse(s))
}

let cachedFixtures: LibraryStory[] | null = null

export function allFixtureStories(): LibraryStory[] {
  cachedFixtures ??= parseFixtures()
  return cachedFixtures
}

export function fixtureFamilyId(): string {
  return fixtures.family_id
}

/** The story a new generation replays, cycling if the parent generates more than once. */
export function streamSourceStory(index: number): LibraryStory {
  const pool = allFixtureStories().slice(LIBRARY_FIXTURE_COUNT)
  const candidates = pool.length > 0 ? pool : allFixtureStories()
  const chosen = candidates[index % candidates.length]
  if (!chosen) throw new Error('mock: no fixture stories available')
  return chosen
}

function freshState(): MockState {
  const stories = new Map<string, LibraryStory>()
  for (const s of allFixtureStories().slice(0, LIBRARY_FIXTURE_COUNT)) {
    stories.set(s.id, s)
  }
  return {
    stories,
    quotaUsed: 1,
    modelCalls: 0,
    generationEnabled: true,
    generated: 0,
  }
}

export function getState(sid: string): MockState {
  let state = sessions.get(sid)
  if (!state) {
    state = freshState()
    sessions.set(sid, state)
  }
  return state
}

export function resetState(sid: string): MockState {
  const state = freshState()
  sessions.set(sid, state)
  return state
}

export function quotaLimit(): number {
  return DAILY_STORY_LIMIT
}

/** Local midnight tonight, which is what `QuotaResponse.resets_at` means (§F8). */
export function resetsAt(now: Date = new Date()): string {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return midnight.toISOString()
}

// ------------------------------------------------------------------ session plumbing
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

function newSessionId(): string {
  return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export interface MockSession {
  sid: string
  state: MockState
  /** Set-Cookie value when the session is new, otherwise null. */
  setCookie: string | null
}

export function sessionFor(req: Request): MockSession {
  const existing = readCookie(req, MOCK_SESSION_COOKIE)
  if (existing) return { sid: existing, state: getState(existing), setCookie: null }
  const sid = newSessionId()
  return {
    sid,
    state: getState(sid),
    setCookie: `${MOCK_SESSION_COOKIE}=${sid}; Path=/; SameSite=Lax; Max-Age=86400`,
  }
}

/** Wrap a handler so it sees state and the session cookie is attached to the response. */
export async function withSession(
  req: Request,
  handler: (session: MockSession) => Response | Promise<Response>,
): Promise<Response> {
  if (!mockEnabled()) {
    return new Response('Not Found', { status: 404 })
  }
  const session = sessionFor(req)
  const res = await handler(session)
  if (session.setCookie) res.headers.append('set-cookie', session.setCookie)
  return res
}

export function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...init?.headers },
  })
}
