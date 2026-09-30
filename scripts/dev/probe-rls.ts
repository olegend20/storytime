/**
 * Ad-hoc RLS verification. Proves the isolation that F2's VTs will assert formally:
 * user A must see ZERO rows of user B's data (not an error), and service-role-only
 * tables must be invisible to authenticated clients.
 *
 *   pnpm tsx scripts/dev/probe-rls.ts
 */
import { createClient } from '@supabase/supabase-js'

const URL = process.env.SUPABASE_URL!
const ANON = process.env.SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })
const results: { check: string; pass: boolean; detail: string }[] = []
const record = (check: string, pass: boolean, detail = '') =>
  results.push({ check, pass, detail })

async function makeUser(email: string) {
  const password = 'probe-password-12345'
  await admin.auth.admin.createUser({ email, password, email_confirm: true })
  const client = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`${email}: ${error.message}`)
  return { client, userId: data.user!.id }
}

async function main() {
  const a = await makeUser(`probe-a-${Date.now()}@test.local`)
  const b = await makeUser(`probe-b-${Date.now()}@test.local`)

  // Each user creates their own family through the anon client (RLS insert policy).
  const famA = await a.client
    .from('families')
    .insert({ owner_user_id: a.userId, display_name: 'Family A' })
    .select()
    .single()
  record('user can insert their own family', !famA.error, famA.error?.message ?? '')

  const famB = await b.client
    .from('families')
    .insert({ owner_user_id: b.userId, display_name: 'Family B' })
    .select()
    .single()
  record('second user can insert their own family', !famB.error, famB.error?.message ?? '')

  // A user must NOT be able to create a family owned by someone else.
  const spoof = await a.client
    .from('families')
    .insert({ owner_user_id: b.userId, display_name: 'Stolen' })
    .select()
  record('cannot insert a family owned by another user', !!spoof.error, spoof.error?.code ?? 'NO ERROR')

  // One family per user.
  const dup = await a.client
    .from('families')
    .insert({ owner_user_id: a.userId, display_name: 'Duplicate' })
    .select()
  record('one family per user (unique index)', !!dup.error, dup.error?.code ?? 'NO ERROR')

  if (famA.data && famB.data) {
    await a.client.from('children').insert({ family_id: famA.data.id, first_name: 'Milo', age: 7 })
    await b.client.from('children').insert({ family_id: famB.data.id, first_name: 'Theo', age: 10 })

    // The core isolation check: zero rows, not an error (F2 VT).
    const seen = await a.client.from('children').select('first_name')
    record(
      'user A sees only their own children (0 rows of B, no error)',
      !seen.error && seen.data?.length === 1 && seen.data[0]!.first_name === 'Milo',
      seen.error ? seen.error.message : JSON.stringify(seen.data),
    )

    const crossFamily = await a.client.from('families').select('display_name')
    record(
      'user A sees only their own family row',
      !crossFamily.error && crossFamily.data?.length === 1,
      JSON.stringify(crossFamily.data),
    )

    // A cannot write into B's family.
    const crossWrite = await a.client
      .from('children')
      .insert({ family_id: famB.data.id, first_name: 'Intruder', age: 5 })
      .select()
    record("cannot insert a child into another family", !!crossWrite.error, crossWrite.error?.code ?? 'NO ERROR')

    // daily_usage is readable but not writable by the family.
    await admin.from('daily_usage').insert({ family_id: famA.data.id, usage_date: '2026-09-27', count: 2 })
    const usageRead = await a.client.from('daily_usage').select('count')
    record('family can read its own daily_usage', !usageRead.error && usageRead.data?.length === 1,
      usageRead.error?.message ?? JSON.stringify(usageRead.data))
    const usageWrite = await a.client
      .from('daily_usage')
      .update({ count: 0 })
      .eq('family_id', famA.data.id)
      .select()
    record('family CANNOT reset its own quota', usageWrite.data?.length === 0 || !!usageWrite.error,
      usageWrite.error?.code ?? `rows=${usageWrite.data?.length}`)
  }

  // Service-role-only tables must be invisible to an authenticated client.
  for (const table of ['generation_logs', 'guardrail_events'] as const) {
    await admin.from(table).insert(
      table === 'generation_logs'
        ? { purpose: 'normalize', model: 'claude-haiku-4-5-20251001', cost_usd: 0.0005 }
        : { layer: 'L1', category: 'off_mission', input_hash: 'x'.repeat(64) },
    )
    const read = await a.client.from(table).select('*')
    record(`${table} invisible to an authenticated client`, (read.data?.length ?? 0) === 0,
      read.error ? read.error.message : `rows=${read.data?.length}`)
    const svc = await admin.from(table).select('*')
    record(`${table} visible to the service role`, (svc.data?.length ?? 0) > 0,
      `rows=${svc.data?.length}`)
  }

  // fact_packs: readable by any authenticated user only when status='ready'.
  await admin.from('fact_packs').insert([
    { topic_key: `ready-${Date.now()}`, topic_label: 'Ready', content: {}, model: 'm', status: 'ready' },
    { topic_key: `building-${Date.now()}`, topic_label: 'Building', content: {}, model: 'm', status: 'building' },
  ])
  const packs = await a.client.from('fact_packs').select('topic_label,status')
  record(
    'fact_packs: ready rows readable, building rows hidden',
    !packs.error && (packs.data ?? []).every((p) => p.status === 'ready') && (packs.data?.length ?? 0) > 0,
    JSON.stringify(packs.data),
  )
  const packWrite = await a.client
    .from('fact_packs')
    .insert({ topic_key: `hack-${Date.now()}`, topic_label: 'Hack', content: {}, model: 'm' })
    .select()
  record('fact_packs not writable by a client', !!packWrite.error, packWrite.error?.code ?? 'NO ERROR')

  // The 24h retention function.
  const { data: purged, error: purgeErr } = await admin.rpc('purge_guardrail_raw_text')
  record('purge_guardrail_raw_text() callable', !purgeErr, purgeErr?.message ?? `purged=${purged}`)

  let failures = 0
  for (const r of results) {
    if (!r.pass) failures += 1
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.check}${r.pass ? '' : `  <- ${r.detail}`}`)
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
