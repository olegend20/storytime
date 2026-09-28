import { describe, expect, it } from 'vitest'
import { getOrBuildFactPack } from '@/lib/topics'
import {
  FACT_PACK_MIN_FACTS,
  FACT_PACK_TOKEN_LIMIT,
} from '@/lib/schemas'
import { estimateTokens } from '@/lib/prompts'
import { MemoryLogSink } from '@/lib/ai'
import { databaseAvailable, serviceClient } from '../helpers/db'

/**
 * F5 VT: "build packs for history-of-lego, sharks, history-of-soccer,
 * history-of-video-games; each has >= 15 facts and includes at least 3 of the anchor facts
 * listed in reference-stories' True Facts sections."
 *
 * These are the REAL topic keys, so the packs land in the globally shared `fact_packs` table
 * exactly as production would - which is the point: after the first run every later run and
 * every other lane gets a cache hit and spends nothing. The test is therefore not cleaned up.
 *
 * Record with:
 *   LIVE_API=1 RECORD_FIXTURES=1 npx vitest run test/int/factpack-live.test.ts
 */

const available = await databaseAvailable()

/** Anchors drawn from each reference story's own True Facts list. */
const TOPICS: { key: string; label: string; anchors: string[] }[] = [
  {
    key: 'history-of-lego',
    label: 'The history of LEGO',
    anchors: ['leg godt', '1958', 'billund', 'ole kirk', 'automatic binding', '1932'],
  },
  {
    key: 'sharks',
    label: 'Sharks',
    anchors: ['cartilage', 'megalodon', 'greenland', 'whale shark', 'hammerhead', 'epaulette'],
  },
  {
    key: 'history-of-soccer',
    label: 'The history of soccer',
    anchors: ['mccrum', 'pickles', '1863', 'cuju', '1930', 'freemasons'],
  },
  {
    key: 'history-of-video-games',
    label: 'The history of video games',
    anchors: ['higinbotham', 'spacewar', 'pong', 'tetris', '1983', 'magnavox'],
  },
]

describe.skipIf(!available)('F5 VT: real fact packs for the four reference topics', () => {
  for (const topic of TOPICS) {
    it(`${topic.key} has enough real facts and hits the anchors`, async () => {
      const sink = new MemoryLogSink()
      const { record } = await getOrBuildFactPack(topic.key, topic.label, {
        db: serviceClient(),
        sink,
        pollTimeoutMs: 300_000,
      })

      expect(record.status).toBe('ready')
      const pack = record.content

      // The VT asks for >= 15, above the schema's floor of 12.
      expect(pack.facts.length, `${topic.key} fact count`).toBeGreaterThanOrEqual(15)
      expect(pack.facts.length).toBeGreaterThanOrEqual(FACT_PACK_MIN_FACTS)

      // Every fact is sourced and has a confidence, which the review pass also enforces.
      for (const fact of pack.facts) {
        expect(fact.source_ids.length, `${fact.id} sources`).toBeGreaterThanOrEqual(1)
        expect(['high', 'medium', 'legend']).toContain(fact.confidence)
      }
      const sourceIds = new Set(pack.sources.map((s) => s.id))
      for (const fact of pack.facts) {
        for (const sid of fact.source_ids) expect(sourceIds.has(sid), `${fact.id} -> ${sid}`).toBe(true)
      }

      // Size cap: the pack has to fit a prompt alongside the bible and the master block.
      expect(estimateTokens(JSON.stringify(pack))).toBeLessThanOrEqual(FACT_PACK_TOKEN_LIMIT)

      // At least 3 of the anchors the reference stories' True Facts lists depend on.
      const haystack = JSON.stringify(pack).toLowerCase()
      const hits = topic.anchors.filter((a) => haystack.includes(a))
      expect(hits.length, `${topic.key} anchors found: ${hits.join(', ')}`).toBeGreaterThanOrEqual(3)

      // A pack that came from cache made no calls at all - the whole point of sharing them.
      const searches = sink.rows.filter((r) => r.purpose === 'factpack')
      expect(searches.length).toBeLessThanOrEqual(1)
    })
  }

  it('a legend is marked as one somewhere in the set, so the writer can hedge it', async () => {
    const db = serviceClient()
    const packs = await Promise.all(
      TOPICS.map((t) => getOrBuildFactPack(t.key, t.label, { db, countUse: false })),
    )
    const confidences = packs.flatMap((p) => p.record.content.facts.map((f) => f.confidence))
    expect(confidences).toContain('legend')
  })
})
