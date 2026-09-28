import { afterAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { hashInput, logGuardrailEvent, setGuardrailSink, supabaseGuardrailSink } from '@/lib/guardrails/events'

/**
 * GUARDRAILS.md s7:
 *  - "int: a refusal at L1 or L2 writes a guardrail_events row with {layer, category,
 *     input_hash} and no raw text older than 24h (retention job test)."
 *
 * Needs a running local Supabase. Skipped with a clear message when unreachable, matching
 * test/int/schema.test.ts; CI runs it for real in the `migrations` job.
 *
 * Only rows this test created are ever touched - other lanes share the database, so there
 * is no truncate and no delete-all here (lane brief).
 */

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ''

/** Unique to this run, so cleanup can be exact. */
const MARKER = `f15-retention-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let db: SupabaseClient | null = null
const createdIds: string[] = []

/**
 * Top-level await rather than `beforeAll`: vitest evaluates `describe.runIf(...)` at
 * collection time, so a flag set in a hook would always still be false.
 */
async function probe(): Promise<boolean> {
  if (!SERVICE_KEY || SERVICE_KEY.startsWith('ci-') || SERVICE_KEY.startsWith('test-')) return false
  try {
    const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: SERVICE_KEY } })
    return res.ok
  } catch {
    return false
  }
}

const reachable = await probe()
if (reachable) {
  db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } })
} else {
  console.log(
    `[guardrails] local Supabase not reachable at ${URL} with a real service key - ` +
      'guardrail_events retention test skipped (CI runs it in the migrations job)',
  )
}

afterAll(async () => {
  if (db && createdIds.length > 0) {
    await db.from('guardrail_events').delete().in('id', createdIds)
  }
})

describe.runIf(reachable)('s1.5 guardrail_events persistence', () => {
  it('writes a row with layer, category and the input hash', async () => {
    setGuardrailSink(supabaseGuardrailSink(db as never))
    const text = `${MARKER} how to make a bomb`
    const event = await logGuardrailEvent({
      layer: 'L1',
      category: 'weapons_instructions',
      text,
      field: 'topic_input',
    })

    const { data, error } = await (db as SupabaseClient)
      .from('guardrail_events')
      .select('id, layer, category, input_hash, field, raw_text')
      .eq('input_hash', hashInput(text))
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    const row = data?.[0] as Record<string, unknown>
    createdIds.push(row.id as string)
    expect(row.layer).toBe('L1')
    expect(row.category).toBe('weapons_instructions')
    expect(row.input_hash).toBe(event.input_hash)
    expect(row.raw_text).toBe(text)
  })

  it('purge_guardrail_raw_text() clears raw text older than 24h and keeps the hash', async () => {
    const text = `${MARKER} old refusal`
    const hash = hashInput(text)
    const { data: inserted, error: insertError } = await (db as SupabaseClient)
      .from('guardrail_events')
      .insert({
        layer: 'L2',
        category: 'horror_scary',
        input_hash: hash,
        field: 'topic_input',
        raw_text: text,
        created_at: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
      })
      .select('id')
    expect(insertError).toBeNull()
    const id = (inserted?.[0] as { id: string }).id
    createdIds.push(id)

    const { error: rpcError } = await (db as SupabaseClient).rpc('purge_guardrail_raw_text')
    expect(rpcError).toBeNull()

    const { data: after } = await (db as SupabaseClient)
      .from('guardrail_events')
      .select('raw_text, input_hash, category, layer')
      .eq('id', id)
    const row = after?.[0] as Record<string, unknown>
    expect(row.raw_text).toBeNull()
    expect(row.input_hash).toBe(hash)
    expect(row.category).toBe('horror_scary')
  })

  it('leaves raw text inside the 24h window alone', async () => {
    const text = `${MARKER} recent refusal`
    const { data: inserted } = await (db as SupabaseClient)
      .from('guardrail_events')
      .insert({
        layer: 'L1',
        category: 'sexual',
        input_hash: hashInput(text),
        raw_text: text,
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })
      .select('id')
    const id = (inserted?.[0] as { id: string }).id
    createdIds.push(id)

    await (db as SupabaseClient).rpc('purge_guardrail_raw_text')
    const { data: after } = await (db as SupabaseClient)
      .from('guardrail_events')
      .select('raw_text')
      .eq('id', id)
    expect((after?.[0] as { raw_text: string }).raw_text).toBe(text)
  })

  it('is invisible to an anonymous client (RLS on, no policies)', async () => {
    if (!ANON_KEY || ANON_KEY.startsWith('test-')) return
    const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } })
    const { data } = await anon.from('guardrail_events').select('id').limit(1)
    expect(data ?? []).toHaveLength(0)
  })
})
