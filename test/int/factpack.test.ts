import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getOrBuildFactPack,
  findFactPack,
  incrementFactPackUse,
  FactPackRejectedError,
  type BuildFactPackResult,
} from '@/lib/topics'
import { databaseAvailable, serviceClient, deleteFactPack } from '../helpers/pipeline-db'
import { goodFactPack } from '../helpers/story'

/**
 * F5 integration tests: the `building` lock, `use_count`, and the rejected path.
 *
 * The builder is injected and counted. The VT asks that a pack is "built at most once per
 * key even under concurrent requests" - counting builder invocations proves that directly,
 * where counting log rows would only imply it.
 */

const available = await databaseAvailable()

describe.skipIf(!available)('F5 fact pack lock and use_count (int)', () => {
  let db: SupabaseClient
  const keys: string[] = []

  function uniqueKey(prefix: string): string {
    const key = `lane2-${prefix}-${randomUUID().slice(0, 8)}`
    keys.push(key)
    return key
  }

  /** A builder that counts its calls and returns a fixed, valid pack. */
  function countingBuilder(topicKey: string) {
    const state = { calls: 0 }
    const builder = async (
      _key: string,
      label: string,
    ): Promise<BuildFactPackResult> => {
      state.calls += 1
      // A real build takes seconds; the delay is what makes the race real.
      await new Promise((r) => setTimeout(r, 120))
      return {
        candidate: { ...goodFactPack(), topic_key: topicKey, topic_label: label },
        model: 'test-builder',
        webSearches: 6,
        costUsd: 0.17,
      }
    }
    return { state, builder }
  }

  /** Accepts whatever the builder produced, so the stored pack keeps the test's topic key. */
  const acceptingReviewer = async (candidate: unknown) => ({
    deterministic: {
      accept: true as const,
      reasons: [] as never[],
      pack: candidate as ReturnType<typeof goodFactPack>,
      tokenEstimate: 900,
    },
    model: { accept: true, quality_score: 4.5, reasons: [] },
  })

  beforeAll(() => {
    db = serviceClient()
  })
  afterAll(async () => {
    for (const key of keys) await deleteFactPack(db, key)
  })

  it('F5 VT: 5 concurrent requests build the pack exactly once and get identical results', async () => {
    const key = uniqueKey('concurrent')
    const { state, builder } = countingBuilder(key)

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        getOrBuildFactPack(key, 'A concurrent topic', {
          db,
          builder,
          reviewer: acceptingReviewer as never,
          pollIntervalMs: 25,
          pollTimeoutMs: 20_000,
        }),
      ),
    )

    // Exactly one build: the other four waited on the `building` row.
    expect(state.calls).toBe(1)
    expect(results.filter((r) => r.built)).toHaveLength(1)

    // All five got the same pack.
    const ids = new Set(results.map((r) => r.record.id))
    expect(ids.size).toBe(1)
    for (const result of results) {
      expect(result.record.status).toBe('ready')
      expect(result.record.content.facts).toHaveLength(14)
      expect(result.record.content.topic_key).toBe(key)
    }

    // Five uses were counted, one per caller.
    const stored = await findFactPack(key, db)
    expect(stored?.use_count).toBe(5)
  })

  it('F5 VT: a second request performs no build at all and use_count reaches 2', async () => {
    const key = uniqueKey('reuse')
    const { state, builder } = countingBuilder(key)
    const options = {
      db,
      builder,
      reviewer: acceptingReviewer as never,
      pollIntervalMs: 25,
      pollTimeoutMs: 20_000,
    }

    const first = await getOrBuildFactPack(key, 'A reused topic', options)
    expect(first.built).toBe(true)
    expect(state.calls).toBe(1)

    const second = await getOrBuildFactPack(key, 'A reused topic', options)
    expect(second.built).toBe(false)
    // No second build: zero further web searches, which is the point of the shared pack.
    expect(state.calls).toBe(1)
    expect(second.record.id).toBe(first.record.id)
    expect(second.record.use_count).toBe(2)
  })

  it('a rejected pack is stored as rejected and raises on every later request', async () => {
    const key = uniqueKey('rejected')
    const { builder } = countingBuilder(key)
    const rejectingReviewer = async () => ({
      deterministic: {
        accept: false as const,
        reasons: ['too_few_facts:4'] as never,
        pack: null,
        tokenEstimate: 100,
      },
      model: { accept: false, quality_score: 1, reasons: ['vague filler'] },
    })

    await expect(
      getOrBuildFactPack(key, 'A bad topic', {
        db,
        builder,
        reviewer: rejectingReviewer as never,
      }),
    ).rejects.toThrow(FactPackRejectedError)

    const { data } = await db
      .from('fact_packs')
      .select('status, quality_score, content')
      .eq('topic_key', key)
      .maybeSingle()
    expect((data as { status: string }).status).toBe('rejected')
    expect((data as { content: { review_reasons: string[] } }).content.review_reasons).toContain(
      'too_few_facts:4',
    )

    // A later request does not silently fall back to generating without facts.
    await expect(getOrBuildFactPack(key, 'A bad topic', { db })).rejects.toThrow(
      FactPackRejectedError,
    )
    // And it is not visible to the read-only lookup.
    expect(await findFactPack(key, db)).toBeNull()
  })

  /**
   * Issue #28 (VT-FP1..3). A topic whose first pack failed the review used to be dead for
   * every family, forever. Now a rejected knowledge pack is researched before the topic is
   * given up on, and a rejection expires after a day.
   */
  function modeBuilder(topicKey: string) {
    const state = { calls: [] as boolean[] }
    const builder = async (
      _key: string,
      label: string,
      opts?: { forceResearch?: boolean },
    ): Promise<BuildFactPackResult> => {
      state.calls.push(opts?.forceResearch === true)
      return {
        candidate: { ...goodFactPack(), topic_key: topicKey, topic_label: label },
        model: 'test-builder',
        webSearches: opts?.forceResearch ? 4 : 0,
        costUsd: 0.1,
        mode: opts?.forceResearch ? 'research' : 'knowledge',
      }
    }
    return { state, builder }
  }
  /** Rejects the knowledge pack, accepts the researched one. */
  const reviewerPreferringSources = () => {
    const seen = { calls: 0 }
    const reviewer = async (candidate: unknown) => {
      seen.calls += 1
      const reject = seen.calls === 1
      return {
        deterministic: { accept: true as const, reasons: [] as never[], pack: candidate as ReturnType<typeof goodFactPack>, tokenEstimate: 900 },
        model: reject ? { accept: false, quality_score: 2.8, reasons: ['vague filler'] } : { accept: true, quality_score: 4.4, reasons: [] },
      }
    }
    return { seen, reviewer }
  }

  it('VT-FP1: a rejected knowledge pack is researched, and the researched pack is what is stored', async () => {
    const key = uniqueKey('fp1')
    const { state, builder } = modeBuilder(key)
    const { seen, reviewer } = reviewerPreferringSources()
    const result = await getOrBuildFactPack(key, 'A topic', { db, builder, reviewer: reviewer as never })
    expect(result.built).toBe(true)
    expect(result.record.status).toBe('ready')
    expect(state.calls).toEqual([false, true]) // knowledge first, then research forced
    expect(seen.calls).toBe(2)
    const { data } = await db.from('fact_packs').select('id').eq('topic_key', key)
    expect(data).toHaveLength(1)
  })

  it('VT-FP1: a research pack that is rejected is not built again', async () => {
    const key = uniqueKey('fp1b')
    const state = { calls: 0 }
    const researchOnly = async (_k: string, label: string): Promise<BuildFactPackResult> => {
      state.calls += 1
      return { candidate: { ...goodFactPack(), topic_key: key, topic_label: label }, model: 'test', webSearches: 4, costUsd: 0.3, mode: 'research' }
    }
    const rejecting = async (candidate: unknown) => ({
      deterministic: { accept: true as const, reasons: [] as never[], pack: candidate as ReturnType<typeof goodFactPack>, tokenEstimate: 900 },
      model: { accept: false, quality_score: 1, reasons: ['plainly wrong dates'] },
    })
    await expect(getOrBuildFactPack(key, 'A topic', { db, builder: researchOnly, reviewer: rejecting as never })).rejects.toThrow(FactPackRejectedError)
    expect(state.calls).toBe(1)
  })

  it('VT-FP2: both attempts rejected -> rejected with both sets of reasons, and no build inside a day', async () => {
    const key = uniqueKey('fp2')
    const { state, builder } = modeBuilder(key)
    let n = 0
    const rejecting = async (candidate: unknown) => {
      n += 1
      return {
        deterministic: { accept: true as const, reasons: [] as never[], pack: candidate as ReturnType<typeof goodFactPack>, tokenEstimate: 900 },
        model: { accept: false, quality_score: 1, reasons: [n === 1 ? 'vague filler' : 'still vague'] },
      }
    }
    await expect(getOrBuildFactPack(key, 'A topic', { db, builder, reviewer: rejecting as never })).rejects.toThrow(FactPackRejectedError)
    expect(state.calls).toEqual([false, true])
    const { data } = await db.from('fact_packs').select('status, content').eq('topic_key', key).maybeSingle()
    expect((data as { status: string }).status).toBe('rejected')
    expect((data as { content: { review_reasons: string[] } }).content.review_reasons).toEqual(['vague filler', 'still vague'])

    // Tonight, the same answer, free.
    await expect(getOrBuildFactPack(key, 'A topic', { db, builder, reviewer: rejecting as never })).rejects.toThrow(FactPackRejectedError)
    expect(state.calls).toHaveLength(2)
  })

  it('VT-FP3: a rejection older than a day is rebuilt by the next request, once', async () => {
    const key = uniqueKey('fp3')
    const { state, builder } = modeBuilder(key)
    const rejecting = async (candidate: unknown) => ({
      deterministic: { accept: true as const, reasons: [] as never[], pack: candidate as ReturnType<typeof goodFactPack>, tokenEstimate: 900 },
      model: { accept: false, quality_score: 1, reasons: ['vague filler'] },
    })
    await expect(getOrBuildFactPack(key, 'A topic', { db, builder, reviewer: rejecting as never })).rejects.toThrow(FactPackRejectedError)
    expect(state.calls).toHaveLength(2)

    // 23 hours later: still the same answer, nothing built.
    const soon = () => Date.now() + 23 * 3_600_000
    await expect(getOrBuildFactPack(key, 'A topic', { db, builder, reviewer: rejecting as never, now: soon })).rejects.toThrow(FactPackRejectedError)
    expect(state.calls).toHaveLength(2)

    // 25 hours later: rebuilt, by one of two simultaneous requests. (The `updated_at`
    // trigger cannot be aged from here, so the clock is the seam.)
    const later = () => Date.now() + 25 * 3_600_000
    const { seen, reviewer } = reviewerPreferringSources()
    const [a, b] = await Promise.all([
      getOrBuildFactPack(key, 'A topic', { db, builder, reviewer: reviewer as never, now: later }),
      getOrBuildFactPack(key, 'A topic', { db, builder, reviewer: reviewer as never, now: later, pollIntervalMs: 20 }),
    ])
    expect(a.record.status).toBe('ready')
    expect(b.record.id).toBe(a.record.id)
    expect([a.built, b.built].filter(Boolean)).toHaveLength(1)
    expect(state.calls).toHaveLength(4) // the first night's two, then knowledge + research once
    expect(seen.calls).toBe(2)
  })

  it('releases the lock when the build itself throws, so the next request can retry', async () => {
    const key = uniqueKey('boom')
    let calls = 0
    const explodingBuilder = async (): Promise<BuildFactPackResult> => {
      calls += 1
      throw new Error('web search unavailable')
    }

    await expect(
      getOrBuildFactPack(key, 'A broken topic', { db, builder: explodingBuilder as never }),
    ).rejects.toThrow('web search unavailable')

    // The `building` row is gone, not left to make everyone else poll a dead build.
    const { data } = await db.from('fact_packs').select('id').eq('topic_key', key).maybeSingle()
    expect(data).toBeNull()

    const { state, builder } = countingBuilder(key)
    const retry = await getOrBuildFactPack(key, 'A broken topic', {
      db,
      builder,
      reviewer: acceptingReviewer as never,
    })
    expect(calls).toBe(1)
    expect(state.calls).toBe(1)
    expect(retry.record.status).toBe('ready')
  })

  it('increments use_count atomically under concurrency', async () => {
    const key = uniqueKey('cas')
    const { builder } = countingBuilder(key)
    const created = await getOrBuildFactPack(key, 'A counted topic', {
      db,
      builder,
      reviewer: acceptingReviewer as never,
      countUse: false,
    })
    expect(created.record.use_count).toBe(0)

    await Promise.all(Array.from({ length: 8 }, () => incrementFactPackUse(created.record.id, db)))
    const stored = await findFactPack(key, db)
    expect(stored?.use_count).toBe(8)
  })
})
