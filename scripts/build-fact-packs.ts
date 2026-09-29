#!/usr/bin/env tsx
/**
 * Build fact packs for named topics, and report what each one cost and how big it is.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… LIVE_API=1 \
 *     tsx scripts/build-fact-packs.ts history-of-lego sharks
 *   tsx scripts/build-fact-packs.ts --chips        # the ten launch-checklist topics (§8)
 *   tsx scripts/build-fact-packs.ts --status       # what is already built, no calls
 *
 * Why a script rather than the F5 test: building a pack is an OPERATION, not an assertion.
 * Running it through vitest meant a heavy test runtime around a web-search tool loop, a
 * per-test timeout that cut four builds off mid-flight and left stale `building` locks, and
 * a run the OS killed under memory pressure. The test's job is to verify packs that exist;
 * this script's job is to make them exist. It is also §8's "ten fact packs pre-built for the
 * suggested-topic chips" item, which needed a home anyway.
 */
import { FACT_PACK_TOKEN_LIMIT } from '@/lib/schemas'
import { getOrBuildFactPack } from '@/lib/topics/factpack'
import { installCliCostLogging } from '@/lib/costs/cli'
import { supabaseService } from '@/lib/supabase/service'
import { MemoryLogSink, TeeLogSink } from '@/lib/ai/types'
import { getDefaultLogSink } from '@/lib/ai/callModel'

/**
 * §8 / F10: the suggested-topic chips, so a first user gets an instant cache hit.
 *
 * The label is what a parent sees on the chip and in the library, and the builder is told to
 * keep it unchanged - so it must be written for people. Passing the key as the label stored
 * "history-of-lego" as the display name of all eight packs built on 2026-09-28.
 * Keys and labels match `EVERGREEN_TOPICS` in lib/client/topics.ts so a chip is never shown twice.
 */
export const CHIP_TOPICS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'history-of-lego', label: 'The history of LEGO' },
  { key: 'sharks', label: 'Sharks' },
  { key: 'history-of-soccer', label: 'The history of soccer' },
  { key: 'history-of-video-games', label: 'The history of video games' },
  { key: 'volcanoes', label: 'How volcanoes work' },
  { key: 'bees', label: 'How bees make honey' },
  { key: 'space-race', label: 'The space race' },
  { key: 'the-titanic', label: 'The Titanic' },
  { key: 'how-magnets-work', label: 'How magnets work' },
  { key: 'dinosaurs', label: 'Dinosaurs' },
]

/** A readable label for a key given on the command line: "how-magnets-work" -> "How magnets work". */
function labelFor(key: string): string {
  const known = CHIP_TOPICS.find((t) => t.key === key)
  if (known) return known.label
  const words = key.split('-').join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const estTokens = (content: unknown): number => Math.round(JSON.stringify(content).length / 4)

async function status(): Promise<void> {
  const { data, error } = await supabaseService()
    .from('fact_packs')
    .select('topic_key,status,content,quality_score,use_count')
    .order('topic_key')
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) {
    console.log('no fact packs yet')
    return
  }
  console.log(`${'topic'.padEnd(26)} ${'status'.padEnd(9)} facts  tokens  quality`)
  for (const row of data) {
    const facts = Array.isArray((row.content as { facts?: unknown[] })?.facts)
      ? (row.content as { facts: unknown[] }).facts.length
      : 0
    const tokens = estTokens(row.content)
    const over = tokens > FACT_PACK_TOKEN_LIMIT ? `  <-- OVER ${FACT_PACK_TOKEN_LIMIT}` : ''
    console.log(
      `${String(row.topic_key).padEnd(26)} ${String(row.status).padEnd(9)} ${String(facts).padStart(5)}  ${String(tokens).padStart(6)}  ${row.quality_score ?? '-'}${over}`,
    )
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--status')) {
    await status()
    return
  }

  const topics = args.includes('--chips')
    ? CHIP_TOPICS.map((t) => t.key)
    : args.filter((a) => !a.startsWith('--'))
  if (topics.length === 0) {
    console.error('usage: tsx scripts/build-fact-packs.ts <topic-key…> | --chips | --status')
    process.exit(1)
  }
  if (process.env.LIVE_API !== '1') {
    console.error('LIVE_API=1 required: building a pack makes real web-search calls.')
    process.exit(1)
  }

  const costs = installCliCostLogging()
  console.log(`[costs] ${costs.reason}`)
  /**
   * Tee, not replace. Passing a bare MemoryLogSink here counted this run's cost and silently
   * bypassed the Supabase sink installed a line above, so `generation_logs` stayed empty.
   */
  const counter = new MemoryLogSink()
  const sink = new TeeLogSink([getDefaultLogSink(), counter])
  let built = 0
  let reused = 0
  const failures: string[] = []

  for (const topic of topics) {
    const started = Date.now()
    try {
      const { record, built: wasBuilt } = await getOrBuildFactPack(topic, labelFor(topic), { sink })
      const tokens = estTokens(record.content)
      const facts = record.content.facts.length
      if (wasBuilt) built += 1
      else reused += 1
      const flag = tokens > FACT_PACK_TOKEN_LIMIT ? `  OVER BUDGET (${FACT_PACK_TOKEN_LIMIT})` : ''
      console.log(
        `  ${topic.padEnd(26)} ${facts} facts, ~${tokens} tokens, ` +
          `${((Date.now() - started) / 1000).toFixed(0)}s${flag}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failures.push(`${topic}: ${msg}`)
      console.log(`  ${topic.padEnd(26)} FAILED after ${((Date.now() - started) / 1000).toFixed(0)}s`)
      console.log(`    ${msg}`)
    }
  }

  console.log(
    `\n${built} built, ${reused} already present, ${failures.length} failed. ` +
      `This run cost $${counter.totalCostUsd.toFixed(4)} over ${counter.rows.length} calls.`,
  )
  if (failures.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
