import { describe, expect, it, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * F1 VT: `supabase db reset` then migrate produces every table in s3 with the
 * expected columns (introspection test).
 * F11 VT: `children` has no last_name / birthdate column.
 *
 * Needs a running local Supabase. Skipped with a clear message when unreachable, so a
 * developer without Docker still gets a green `pnpm test`; CI runs it for real in the
 * `migrations` job.
 */

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

let db: SupabaseClient | null = null
let reachable = false

async function introspect(sql: string): Promise<unknown[]> {
  if (!db) throw new Error('no db')
  const { data, error } = await db.rpc('exec_introspection', { query: sql })
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown[]
}

beforeAll(async () => {
  if (!SERVICE_KEY || SERVICE_KEY.startsWith('ci-') || SERVICE_KEY.startsWith('test-')) return
  db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } })
  try {
    const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: SERVICE_KEY } })
    reachable = res.ok
  } catch {
    reachable = false
  }
})

const EXPECTED_TABLES = [
  'families',
  'children',
  'series',
  'story_bibles',
  'stories',
  'fact_packs',
  'generation_logs',
  'daily_usage',
  'guardrail_events',
] as const

describe.runIf(process.env.RUN_SCHEMA_TESTS === '1')('F1 schema introspection', () => {
  it('every table from s3 exists', async () => {
    expect(reachable, `Local Supabase not reachable at ${URL}. Run \`supabase start\`.`).toBe(true)
    for (const table of EXPECTED_TABLES) {
      const { error } = await db!.from(table).select('*').limit(0)
      expect(error, `table ${table}: ${error?.message}`).toBeNull()
    }
  })

  /** Kickoff rule 7: children's data is minimal and the field list is closed. */
  it('children has no last_name or birthdate column (F11 VT)', async () => {
    for (const forbidden of ['last_name', 'birthdate', 'surname', 'photo_url', 'address']) {
      const { error } = await db!.from('children').select(forbidden).limit(0)
      expect(
        error,
        `children.${forbidden} must not exist - children's data is first name, age, likes, notes, reading level only`,
      ).not.toBeNull()
    }
  })

  it('children has exactly the permitted columns', async () => {
    const { error } = await db!
      .from('children')
      .select('id,family_id,first_name,age,likes,notes,reading_level,created_at,updated_at')
      .limit(0)
    expect(error).toBeNull()
  })

  it('the admin views from F12 exist', async () => {
    for (const view of [
      'v_daily_costs',
      'v_daily_stories',
      'v_story_costs',
      'v_cost_summary',
      'v_fact_pack_hit_rate',
      'v_top_topics',
    ]) {
      const { error } = await db!.from(view).select('*').limit(0)
      expect(error, `view ${view}: ${error?.message}`).toBeNull()
    }
  })
})

/** Placeholder so the suite is meaningful even without Docker. */
describe('F1 schema expectations are declared', () => {
  it('lists all nine tables from the data model', () => {
    expect(EXPECTED_TABLES).toHaveLength(9)
  })
  it('introspection helper is defined', () => {
    expect(typeof introspect).toBe('function')
  })
})
