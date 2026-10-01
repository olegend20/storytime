import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { recallSuggestedTopics, rememberSuggestedTopics } from '@/lib/client/topics'

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

  it('a browser with no storage still works: nothing remembered, nothing thrown', () => {
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage
    expect(() => rememberSuggestedTopics(TOPICS)).not.toThrow()
    expect(recallSuggestedTopics()).toBeNull()
  })
})
