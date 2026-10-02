/**
 * Make ONE real story for the seeded dev family and print what the gates made of it.
 *
 *   LIVE_API=1 pnpm tsx scripts/dev/try-story.ts "Spider-Man teaches Juno to climb walls"
 *
 * Costs money (one story: about $0.20-0.40 with a rewrite, plus a fact pack for a new
 * topic). Local database only - it refuses anything else. Written for issue #27, to read a
 * borrowed-character story end to end before the owner did; kept because "what does the
 * pipeline actually do with this topic" is a question that comes up every week.
 */
import { createClient } from '@supabase/supabase-js'
import { MemoryLogSink } from '@/lib/ai'
import { prepareGeneration, runGeneration, SseChannel } from '@/lib/generate'
import { productionDeps } from '@/lib/generate/production-deps'
import type { SseEvent } from '@/lib/schemas'

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

async function main(): Promise<void> {
  const topic = process.argv.slice(2).join(' ').trim()
  if (!topic) throw new Error('usage: try-story.ts "<topic>"')
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  if (!URL.includes('127.0.0.1') && !URL.includes('localhost')) {
    throw new Error(`Refusing to write stories into a non-local database: ${URL}`)
  }
  if (process.env.LIVE_API !== '1') throw new Error('Set LIVE_API=1: this makes real model calls.')

  const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } })
  const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 })
  const userId = list?.users.find((u) => u.email === 'dev@storytime.test')?.id
  if (!userId) throw new Error('No seeded family: run `pnpm seed` first.')
  const { data: family } = await db.from('families').select('id').eq('owner_user_id', userId).single()
  const { data: children } = await db.from('children').select('id, first_name, age').eq('family_id', family!.id)
  if (!children?.length) throw new Error('The seeded family has no children.')

  const sink = new MemoryLogSink()
  const deps = { ...productionDeps(db), db, sink }
  const started = Date.now()
  const prep = await prepareGeneration(
    family!.id,
    { child_ids: children.map((c) => c.id), topic_input: topic, tones: ['funny', 'exciting'], length_minutes: 5 },
    deps,
  )
  if (!prep.ok) {
    console.log(`REFUSED/FAILED before writing: ${prep.status} ${JSON.stringify(prep.error)}`)
    return
  }
  const p = prep.prepared
  console.log(`topic_key=${p.topicKey}  label="${p.topicLabel}"  band=${p.band}`)
  console.log(`requested_characters=${JSON.stringify(p.request.requested_characters)}  content_notice=${p.contentNotice}`)
  console.log(`care_notes: ${p.request.care_notes}`)

  const channel = new SseChannel()
  const events: SseEvent[] = []
  const drain = (async () => {
    try {
      for await (const e of channel.events()) events.push(e)
    } catch {
      /* reported below */
    }
  })()
  const result = await runGeneration(p, channel, deps)
  await drain
  if (result.bibleUpdate) await result.bibleUpdate

  const cost = sink.rows.reduce((t, r) => t + (r.cost_usd ?? 0), 0)
  console.log(`\nstatus=${result.status}  write_calls=${result.writeCalls}  words=${result.wordCount}  ${((Date.now() - started) / 1000).toFixed(0)}s  $${cost.toFixed(3)}`)
  const err = events.find((e) => e.type === 'error')
  if (err) console.log(`error event: ${JSON.stringify(err)}`)
  if (result.quality) console.log(`quality: ${JSON.stringify(result.quality).slice(0, 600)}`)
  if (result.story) {
    console.log(`\n# ${result.story.title}\n_${result.story.subtitle ?? ''}_\n`)
    for (const ch of result.story.chapters) console.log(`## ${ch.heading}\n${ch.text}\n${ch.shout_line ? `**${ch.shout_line}**\n` : ''}`)
    console.log(`\n${result.story.ending_line}\n\nTrue facts:\n${result.story.true_facts.map((f) => `- ${f.text}`).join('\n')}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
