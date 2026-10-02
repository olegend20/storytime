import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EVERGREEN_TOPICS,
  forgetSuggestedTopics,
  ideaPool,
  ideasFrom,
  recallSuggestedTopics,
  rememberSuggestedTopics,
} from '@/lib/client/topics'

/** The creator asks for topic ideas once per browser session (issue #17). */

const TOPICS = [
  { label: 'Sharks', topic_key: 'sharks', warm: true },
  { label: 'How bees make honey', topic_key: 'bees', warm: false },
]

describe('suggested-topics session cache', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    ;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
  })
  afterEach(() => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  })

  it('remembers the ideas, and gives them back unchanged', () => {
    expect(recallSuggestedTopics()).toBeNull()
    rememberSuggestedTopics(TOPICS, 1_000)
    expect(recallSuggestedTopics(2_000)).toEqual(TOPICS)
  })

  it('forgets them after ten minutes', () => {
    rememberSuggestedTopics(TOPICS, 0)
    expect(recallSuggestedTopics(10 * 60 * 1000)).toEqual(TOPICS)
    expect(recallSuggestedTopics(10 * 60 * 1000 + 1)).toBeNull()
  })

  it('ignores anything in storage that is not the shape it wrote', () => {
    store.set('storytime:v1:suggested-topics', JSON.stringify({ at: 1, topics: [{ label: '<b>x</b>' }] }))
    expect(recallSuggestedTopics(2)).toBeNull()
    store.set('storytime:v1:suggested-topics', 'not json')
    expect(recallSuggestedTopics(2)).toBeNull()
  })

  it('can be forgotten, so the next visit asks again', () => {
    rememberSuggestedTopics(TOPICS, 1_000)
    forgetSuggestedTopics()
    expect(recallSuggestedTopics(2_000)).toBeNull()
  })

  it('a browser with no storage still works: nothing remembered, nothing thrown', () => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage
    expect(() => rememberSuggestedTopics(TOPICS)).not.toThrow()
    expect(recallSuggestedTopics()).toBeNull()
  })
})

describe('the idea pool behind "More ideas"', () => {
  const warm = [
    { label: 'Sharks', topic_key: 'sharks', warm: true },
    { label: 'Trains', topic_key: 'trains', warm: true },
  ]

  it('holds every idea once: ready fact packs first, then the whole evergreen pool', () => {
    const pool = ideaPool({ fromServer: warm, offset: 5 })
    expect(pool.slice(0, 2)).toEqual(warm)
    // "sharks" is both a ready pack and an evergreen idea: it appears once.
    expect(pool.length).toBe(warm.length + EVERGREEN_TOPICS.length - 1)
    expect(new Set(pool.map((t) => t.topic_key)).size).toBe(pool.length)
  })

  it('paging three at a time reaches every idea before any repeats', () => {
    const pool = ideaPool({ fromServer: warm })
    const seen: string[] = []
    for (let start = 0; start < pool.length; start += 3) {
      seen.push(...ideasFrom(pool, start, 3).map((t) => t.topic_key))
    }
    expect(new Set(seen)).toEqual(new Set(pool.map((t) => t.topic_key)))
  })

  it('wraps round the end, and never shows more ideas than exist', () => {
    const pool = ideaPool({ fromServer: [] })
    expect(ideasFrom(pool, pool.length - 1, 3).map((t) => t.topic_key)).toEqual([
      pool[pool.length - 1]!.topic_key,
      pool[0]!.topic_key,
      pool[1]!.topic_key,
    ])
    expect(ideasFrom(pool.slice(0, 2), 0, 3)).toHaveLength(2)
    expect(ideasFrom([], 0, 3)).toEqual([])
  })
})
