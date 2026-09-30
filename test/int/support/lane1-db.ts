import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Integration-test plumbing for the SHARED local Supabase.
 *
 * NOTE FOR THE LEAD: lane 3 has written `test/helpers/db.ts` for the same purpose, which
 * is not on this branch. This file is deliberately named for this lane so the two cannot
 * collide at merge; everything below should be replaced by lane 3's helper, and the only
 * thing lane 1's tests need from it is the list at the bottom of this comment.
 *
 * What lane 1 needs from a shared helper:
 *   1. `localDbAvailable()`   - credentials + a reachability probe, so `pnpm test` skips
 *                               cleanly on a machine with no Docker and in the CI `check`
 *                               job (which sets placeholder keys and starts no database).
 *   2. `serviceClient()`      - a service-role client (bypasses RLS).
 *   3. `createTestUser()`     - a confirmed auth user plus an anon-key client signed in AS
 *                               that user, so RLS is exercised for real.
 *   4. `cleanupUser()`        - delete just that user; the `auth.users` -> `families`
 *                               cascade removes everything the test made and nothing else.
 *
 * Shared-database rules (docs/LANE_BRIEF.md): never truncate, never delete-all, never
 * `db reset`. Every helper here is scoped to a uniquely named user this file created.
 */

/** The standard `supabase start` demo keys, published in docs/LANE_BRIEF.md. */
const LOCAL_URL = 'http://127.0.0.1:54321'
const LOCAL_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const LOCAL_SERVICE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

/** `test/setup.ts` and CI both inject obvious placeholders; those are not credentials. */
function isPlaceholder(key: string | undefined): boolean {
  return !key || key.startsWith('test-') || key.startsWith('ci-')
}

export interface LocalDb {
  url: string
  anonKey: string
  serviceKey: string
}

function resolveCredentials(): LocalDb {
  const url = process.env.SUPABASE_URL ?? LOCAL_URL
  const anonKey = isPlaceholder(process.env.SUPABASE_ANON_KEY)
    ? LOCAL_ANON
    : process.env.SUPABASE_ANON_KEY!
  const serviceKey = isPlaceholder(process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? LOCAL_SERVICE
    : process.env.SUPABASE_SERVICE_ROLE_KEY!
  return { url, anonKey, serviceKey }
}

export const localDb = resolveCredentials()

/** True when a Supabase with our schema is answering. Used to skip, never to fake a pass. */
export async function localDbAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${localDb.url}/rest/v1/families?select=id&limit=0`, {
      headers: { apikey: localDb.serviceKey, authorization: `Bearer ${localDb.serviceKey}` },
      signal: AbortSignal.timeout(2_000),
    })
    return response.ok
  } catch {
    return false
  }
}

export const SKIP_REASON =
  `Local Supabase not reachable at ${localDb.url}. Run \`supabase start\` to run the ` +
  'integration tests for real.'

export function serviceClient(): SupabaseClient {
  return createClient(localDb.url, localDb.serviceKey, { auth: { persistSession: false } })
}

/** An anon-key client with no session: what an unauthenticated caller gets. */
export function anonClient(): SupabaseClient {
  return createClient(localDb.url, localDb.anonKey, { auth: { persistSession: false } })
}

export interface TestUser {
  userId: string
  email: string
  /** Anon-key client signed in as this user, so every query goes through RLS. */
  client: SupabaseClient
}

const PASSWORD = 'lane1-integration-password-12345'
let counter = 0

/**
 * Create a confirmed user and sign in as them.
 *
 * @param label a short tag that ends up in the email address, to make a stray row obvious
 */
export async function createTestUser(label: string): Promise<TestUser> {
  counter += 1
  const email = `lane1-${label}-${Date.now()}-${counter}@storytime.test`
  const admin = serviceClient()
  const created = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (created.error || !created.data.user) {
    throw new Error(`could not create ${email}: ${created.error?.message}`)
  }
  const client = anonClient()
  const signedIn = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (signedIn.error) throw new Error(`could not sign in ${email}: ${signedIn.error.message}`)
  return { userId: created.data.user.id, email, client }
}

/**
 * Remove one test user. `families.owner_user_id references auth.users on delete cascade`,
 * so this takes the family and everything under it with it - and nothing else.
 */
export async function cleanupUser(user: Pick<TestUser, 'userId'> | null): Promise<void> {
  if (!user) return
  try {
    await serviceClient().auth.admin.deleteUser(user.userId)
  } catch {
    /* already gone: an account-deletion test removed it itself */
  }
}
