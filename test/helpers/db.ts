import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

/**
 * Integration-test helpers for the SHARED local database.
 *
 * Working agreement: never TRUNCATE, never delete-all, never `supabase db reset` — other
 * lanes are using the same rows right now. Every helper here creates uniquely-named rows and
 * every test cleans up exactly what it made, through `TestWorld.cleanup()`.
 */

/**
 * `test/setup.ts` fills the Supabase env with placeholders so unit tests need no database.
 * When we see those exact placeholders we substitute the standard Supabase CLI demo keys —
 * the ones every local `supabase start` produces, published in docs/LANE_BRIEF.md, and
 * worthless anywhere but 127.0.0.1. That is what lets `pnpm test` exercise these integration
 * tests locally without a .env file, while CI's `check` job (which sets its own `ci-*` keys
 * and starts no database) still skips them.
 */
const SETUP_PLACEHOLDERS = new Set(['test-anon-key', 'test-service-role-key', ''])
const LOCAL_DEMO_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_DEMO_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function key(fromEnv: string | undefined, demo: string): string {
  const raw = fromEnv ?? ''
  return SETUP_PLACEHOLDERS.has(raw) ? demo : raw
}

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = key(process.env.SUPABASE_SERVICE_ROLE_KEY, LOCAL_DEMO_SERVICE_KEY)
const ANON_KEY = key(process.env.SUPABASE_ANON_KEY, LOCAL_DEMO_ANON_KEY)

/** CI's `check` job sets `ci-*` keys and runs no database; these tests skip there. */
export function hasRealKeys(): boolean {
  return SERVICE_KEY !== '' && !SERVICE_KEY.startsWith('ci-')
}

/**
 * The service key these tests will use. Code under test reads `process.env` through
 * `lib/supabase/service.ts`, so tests that exercise that path must push these values back
 * into the environment first — see `applyTestSupabaseEnv()`.
 */
export function testSupabaseEnv(): { url: string; serviceKey: string; anonKey: string } {
  return { url: URL, serviceKey: SERVICE_KEY, anonKey: ANON_KEY }
}

/**
 * Point `lib/supabase/service.ts` at the same local database this helper uses. Call in
 * `beforeAll` for any test that goes through production code rather than `service()`.
 */
export function applyTestSupabaseEnv(): void {
  process.env.SUPABASE_URL = URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
  process.env.SUPABASE_ANON_KEY = ANON_KEY
}

export async function dbReachable(): Promise<boolean> {
  if (!hasRealKeys()) return false
  try {
    const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: SERVICE_KEY } })
    return res.ok
  } catch {
    return false
  }
}

/** The reason an integration test skipped, so a skip is never silent. */
export const SKIP_REASON =
  `Local Supabase not reachable at ${URL} with a real service key. ` +
  `Run \`supabase start\` and export SUPABASE_SERVICE_ROLE_KEY.`

let svc: SupabaseClient | null = null
export function service(): SupabaseClient {
  if (!svc) svc = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  return svc
}

/** A client with the anon key and no session: what an unauthenticated browser gets. */
export function anon(): SupabaseClient {
  return createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
}

export interface TestFamily {
  userId: string
  familyId: string
  email: string
  timezone: string
}

/**
 * Tracks everything a test created so cleanup is exact. `generation_logs` and `fact_packs`
 * are global tables shared with other lanes, so they are deleted by explicit id only.
 */
export class TestWorld {
  readonly tag = `t3-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  private readonly families: TestFamily[] = []
  private readonly logIds: string[] = []
  private readonly factPackIds: string[] = []
  private readonly storyIds: string[] = []
  private readonly seriesIds: string[] = []

  get db(): SupabaseClient {
    return service()
  }

  async createFamily(opts: { timezone?: string; label?: string } = {}): Promise<TestFamily> {
    const timezone = opts.timezone ?? 'UTC'
    const email = `${this.tag}-${opts.label ?? 'f'}-${randomUUID().slice(0, 6)}@storytime.test`
    const { data: created, error: userErr } = await this.db.auth.admin.createUser({
      email,
      password: randomUUID(),
      email_confirm: true,
    })
    if (userErr || !created.user) throw new Error(`createUser failed: ${userErr?.message}`)

    const { data: family, error: famErr } = await this.db
      .from('families')
      .insert({ owner_user_id: created.user.id, display_name: `Lane3 ${opts.label ?? 'test'}`, timezone })
      .select('id')
      .single()
    if (famErr || !family) throw new Error(`family insert failed: ${famErr?.message}`)

    const record: TestFamily = { userId: created.user.id, familyId: family.id as string, email, timezone }
    this.families.push(record)
    return record
  }

  async createSeries(familyId: string): Promise<string> {
    const { data, error } = await this.db
      .from('series')
      .insert({ family_id: familyId, child_ids: [], child_key: `${this.tag}-${randomUUID().slice(0, 8)}` })
      .select('id')
      .single()
    if (error || !data) throw new Error(`series insert failed: ${error?.message}`)
    const id = data.id as string
    this.seriesIds.push(id)
    return id
  }

  async createFactPack(opts: { createdAt?: string; label?: string } = {}): Promise<string> {
    const { data, error } = await this.db
      .from('fact_packs')
      .insert({
        topic_key: `${this.tag}-${opts.label ?? 'topic'}-${randomUUID().slice(0, 8)}`,
        topic_label: `Lane 3 test topic ${opts.label ?? ''}`.trim(),
        content: {},
        sources: [],
        model: 'test-fixture',
        status: 'ready',
        ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`fact_pack insert failed: ${error?.message}`)
    const id = data.id as string
    this.factPackIds.push(id)
    return id
  }

  async createStory(opts: {
    familyId: string
    seriesId: string
    factPackId?: string | null
    createdAt?: string
    status?: 'ready' | 'flagged' | 'failed'
    topicKey?: string
  }): Promise<string> {
    const { data, error } = await this.db
      .from('stories')
      .insert({
        family_id: opts.familyId,
        series_id: opts.seriesId,
        topic_input: 'lane 3 integration test',
        topic_key: opts.topicKey ?? `${this.tag}-story`,
        fact_pack_id: opts.factPackId ?? null,
        tones: ['funny'],
        length_minutes: 10,
        age_band: 'A',
        title: 'Test story',
        content: {},
        word_count: 1500,
        quality: {},
        status: opts.status ?? 'ready',
        ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`story insert failed: ${error?.message}`)
    const id = data.id as string
    this.storyIds.push(id)
    return id
  }

  async insertLog(row: {
    familyId?: string | null
    storyId?: string | null
    purpose?: string
    model?: string
    costUsd: number
    createdAt?: string
    ok?: boolean
    inputTokens?: number
    cacheReadTokens?: number
    outputTokens?: number
    latencyMs?: number
  }): Promise<string> {
    const { data, error } = await this.db
      .from('generation_logs')
      .insert({
        family_id: row.familyId ?? null,
        story_id: row.storyId ?? null,
        purpose: row.purpose ?? 'write',
        model: row.model ?? 'claude-sonnet-5',
        input_tokens: row.inputTokens ?? 0,
        cache_read_tokens: row.cacheReadTokens ?? 0,
        cache_write_tokens: 0,
        output_tokens: row.outputTokens ?? 0,
        cost_usd: row.costUsd,
        latency_ms: row.latencyMs ?? 1000,
        ok: row.ok ?? true,
        ...(row.createdAt ? { created_at: row.createdAt } : {}),
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`generation_logs insert failed: ${error?.message}`)
    const id = data.id as string
    this.logIds.push(id)
    return id
  }

  /** Remember a log row this test caused indirectly (e.g. through callModel), so it is cleaned up. */
  trackLogIds(ids: string[]): void {
    this.logIds.push(...ids)
  }

  /** Exact reverse-order teardown. Never a bulk delete. */
  async cleanup(): Promise<void> {
    if (this.logIds.length > 0) await this.db.from('generation_logs').delete().in('id', this.logIds)
    if (this.storyIds.length > 0) await this.db.from('stories').delete().in('id', this.storyIds)
    if (this.factPackIds.length > 0) await this.db.from('fact_packs').delete().in('id', this.factPackIds)
    if (this.seriesIds.length > 0) await this.db.from('series').delete().in('id', this.seriesIds)
    for (const f of this.families) {
      // Cascades to families → children, series, stories, daily_usage.
      // generation_logs.family_id is ON DELETE SET NULL: cost history survives (F2 AC).
      await this.db.auth.admin.deleteUser(f.userId)
    }
    this.logIds.length = 0
    this.storyIds.length = 0
    this.factPackIds.length = 0
    this.seriesIds.length = 0
    this.families.length = 0
  }
}
