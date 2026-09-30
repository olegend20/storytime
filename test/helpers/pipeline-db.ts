/**
 * Pipeline-test fixtures (lane 2: F4-F7). A self-contained family fixture that carries its
 * own client, children and cleanup, which is what the generation-pipeline tests want.
 *
 * `test/helpers/db.ts` is the other one, and neither is wrong: that one pairs a plain
 * `TestFamily` record with a `TestWorld` that tracks every row a test created, which is
 * what the quota and admin tests want. The two `TestFamily` shapes are incompatible, so
 * they live in separate modules rather than one being bent to fit the other.
 *
 * Both obey the same rule about the shared local database: delete only what you created,
 * never TRUNCATE, never `supabase db reset`.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

/**
 * Integration-test fixtures against the shared local Supabase.
 *
 * LANE_BRIEF rule: never TRUNCATE, never delete-all, never `supabase db reset` - other
 * lanes are using the same rows. Every helper here creates its own user/family with unique
 * ids and `cleanup()` removes ONLY what it made, by id.
 */

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'

/**
 * `test/setup.ts` installs placeholder Supabase keys so unit tests need no database. For
 * integration tests we want the real local one whenever it is running, so fall back to the
 * standard Supabase local demo service key - the same value LANE_BRIEF publishes, safe to
 * use locally and worthless anywhere else. Kept here rather than in the shared
 * `test/setup.ts` so this is lane 2's choice and not a change to everyone's harness.
 */
const LOCAL_DEMO_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

function serviceKey(): string {
  const fromEnv = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const isPlaceholder =
    fromEnv === '' || fromEnv.startsWith('test-') || fromEnv.startsWith('ci-')
  return isPlaceholder && SUPABASE_URL.includes('127.0.0.1')
    ? LOCAL_DEMO_SERVICE_KEY
    : fromEnv
}

const SERVICE_KEY = serviceKey()

/** False when there is no usable key or the local Supabase is not running. */
export async function databaseAvailable(): Promise<boolean> {
  if (!SERVICE_KEY) return false
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: SERVICE_KEY } })
    return res.ok
  } catch {
    return false
  }
}

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
}

export interface TestFamily {
  db: SupabaseClient
  userId: string
  familyId: string
  children: { id: string; first_name: string; age: number }[]
  /** Removes only the rows this fixture created. */
  cleanup: () => Promise<void>
}

export interface CreateFamilyOptions {
  children?: { first_name: string; age: number; likes?: string[]; notes?: string | null }[]
  timezone?: string
  /** Suffix for the generated email, to keep parallel suites apart. */
  label?: string
}

const DEFAULT_CHILDREN = [
  { first_name: 'Milo', age: 7, likes: ['LEGO', 'sharks'], notes: 'often the one with the idea' },
  { first_name: 'Juno', age: 4, likes: ['dinosaurs'], notes: 'loves shouting the sound words' },
]

export async function createTestFamily(opts: CreateFamilyOptions = {}): Promise<TestFamily> {
  const db = serviceClient()
  const label = opts.label ?? 'lane2'
  const email = `${label}-${randomUUID()}@storytime.test`

  const { data: created, error: userError } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
  })
  if (userError || !created?.user) {
    throw new Error(`createTestFamily: could not create user: ${userError?.message}`)
  }
  const userId = created.user.id

  const { data: family, error: familyError } = await db
    .from('families')
    .insert({
      owner_user_id: userId,
      display_name: `Test family ${label}`,
      timezone: opts.timezone ?? 'UTC',
    })
    .select('id')
    .single()
  if (familyError) throw new Error(`createTestFamily: ${familyError.message}`)
  const familyId = (family as { id: string }).id

  const { data: childRows, error: childError } = await db
    .from('children')
    .insert(
      (opts.children ?? DEFAULT_CHILDREN).map((c) => ({
        family_id: familyId,
        first_name: c.first_name,
        age: c.age,
        likes: c.likes ?? [],
        notes: c.notes ?? null,
      })),
    )
    .select('id, first_name, age')
  if (childError) throw new Error(`createTestFamily: ${childError.message}`)

  const cleanup = async (): Promise<void> => {
    // Order matters only for generation_logs, which we null out rather than delete so the
    // cost history survives (mirrors the F2 account-deletion rule).
    await db.from('generation_logs').update({ family_id: null }).eq('family_id', familyId)
    await db.from('stories').delete().eq('family_id', familyId)
    await db.from('story_bibles').delete().eq('family_id', familyId)
    await db.from('series').delete().eq('family_id', familyId)
    await db.from('children').delete().eq('family_id', familyId)
    await db.from('daily_usage').delete().eq('family_id', familyId)
    await db.from('families').delete().eq('id', familyId)
    await db.auth.admin.deleteUser(userId)
  }

  return {
    db,
    userId,
    familyId,
    children: (childRows ?? []) as TestFamily['children'],
    cleanup,
  }
}

/**
 * Insert a fact pack with FIXED content under a unique topic key.
 *
 * Deterministic content matters more than realism here: the pack flows into the writer's
 * prompt, so a pack that varied between runs would change the prompt bytes and invalidate
 * every recorded story fixture. Tests that want a real researched pack use the live F5 test.
 */
export async function insertFactPack(
  db: SupabaseClient,
  topicKey: string,
  content: unknown,
  topicLabel: string,
): Promise<string> {
  const { data, error } = await db
    .from('fact_packs')
    .upsert(
      {
        topic_key: topicKey,
        topic_label: topicLabel,
        content,
        sources: (content as { sources?: unknown }).sources ?? [],
        model: 'fixture',
        status: 'ready',
        use_count: 0,
        quality_score: 4.5,
      },
      { onConflict: 'topic_key' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`insertFactPack: ${error.message}`)
  return (data as { id: string }).id
}

export async function deleteFactPack(db: SupabaseClient, topicKey: string): Promise<void> {
  await db.from('fact_packs').delete().eq('topic_key', topicKey)
}
