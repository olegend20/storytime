import type { SuggestedTopicsResponse } from '@/lib/schemas'

/**
 * The 8 suggested topic chips (§6 F10).
 *
 * `GET /api/topics/suggested` returns at most 8, drawn from the most-used fact packs. Early
 * on there are no fact packs, so the endpoint will return few or none - and "8 rotating
 * chips" is an AC, not a best effort. The list is therefore topped up from an evergreen pool
 * here, which is also the split Appendix B3 chose ("4 evergreen + 4 most-used fact packs").
 *
 * Server topics come first: `warm: true` means a fact pack exists, so that story starts
 * generating without a research call.
 */

export type SuggestedTopic = SuggestedTopicsResponse['topics'][number]

/**
 * Evergreen ideas. Every one is inside the allow list in `GUARDRAILS.md` §3.3 (history,
 * science, nature, technology, sport, "how X works"), and every one is phrased the way a
 * parent would type it.
 */
export const EVERGREEN_TOPICS: readonly SuggestedTopic[] = [
  { label: 'How bees make honey', topic_key: 'bees', warm: false },
  { label: 'The history of LEGO', topic_key: 'history-of-lego', warm: false },
  { label: 'How volcanoes work', topic_key: 'volcanoes', warm: false },
  { label: 'Sharks', topic_key: 'sharks', warm: false },
  { label: 'The space race', topic_key: 'space-race', warm: false },
  { label: 'How bicycles were invented', topic_key: 'history-of-bicycles', warm: false },
  { label: 'Why do we sleep?', topic_key: 'why-we-sleep', warm: false },
  { label: 'The history of soccer', topic_key: 'history-of-soccer', warm: false },
  { label: 'Dinosaurs', topic_key: 'dinosaurs', warm: false },
  { label: 'How planes fly', topic_key: 'how-planes-fly', warm: false },
  { label: 'The deepest part of the ocean', topic_key: 'deep-ocean', warm: false },
  { label: 'How chocolate is made', topic_key: 'how-chocolate-is-made', warm: false },
]

export const SUGGESTED_CHIP_COUNT = 8

/**
 * Build the chip row. Rotation is an offset into the evergreen pool rather than a shuffle, so
 * "More ideas" always changes the row and never repeats a chip already on screen.
 */
export function suggestedChips(input: {
  fromServer?: readonly SuggestedTopic[]
  offset?: number
  count?: number
  pool?: readonly SuggestedTopic[]
}): SuggestedTopic[] {
  const count = input.count ?? SUGGESTED_CHIP_COUNT
  const pool = input.pool ?? EVERGREEN_TOPICS
  const chips: SuggestedTopic[] = []
  const seen = new Set<string>()
  for (const t of input.fromServer ?? []) {
    if (chips.length >= count) break
    if (seen.has(t.topic_key)) continue
    seen.add(t.topic_key)
    chips.push(t)
  }
  if (pool.length > 0) {
    const start = ((input.offset ?? 0) % pool.length + pool.length) % pool.length
    for (let i = 0; i < pool.length && chips.length < count; i++) {
      const t = pool[(start + i) % pool.length]
      if (!t || seen.has(t.topic_key)) continue
      seen.add(t.topic_key)
      chips.push(t)
    }
  }
  return chips
}

/**
 * Starting offset, so the row differs from one night to the next without any stored state.
 * Days since the epoch, which is stable within a single evening.
 */
export function offsetForDay(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 86_400_000)
}

/**
 * The suggested topics, remembered for the browser session (issue #17).
 *
 * The creator is now the home page, so it is opened far more often than `/new` was; the ideas
 * change at most when a fact pack is built, so one request per session (or ten minutes) is
 * plenty. sessionStorage, try/catch: a browser blocking site data must still get its chips.
 */
const TOPICS_CACHE_KEY = 'storytime:v1:suggested-topics'
const TOPICS_CACHE_MS = 10 * 60 * 1000

export function recallSuggestedTopics(now: number = Date.now()): SuggestedTopic[] | null {
  try {
    const raw = sessionStorage.getItem(TOPICS_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at?: unknown; topics?: unknown }
    if (typeof parsed.at !== 'number' || now - parsed.at > TOPICS_CACHE_MS || !Array.isArray(parsed.topics)) return null
    const topics = parsed.topics.filter(
      (t): t is SuggestedTopic =>
        typeof t === 'object' && t !== null &&
        typeof (t as SuggestedTopic).label === 'string' &&
        typeof (t as SuggestedTopic).topic_key === 'string' &&
        typeof (t as SuggestedTopic).warm === 'boolean',
    )
    return topics.length === parsed.topics.length ? topics : null
  } catch {
    return null
  }
}

export function rememberSuggestedTopics(topics: readonly SuggestedTopic[], now: number = Date.now()): void {
  try {
    sessionStorage.setItem(TOPICS_CACHE_KEY, JSON.stringify({ at: now, topics }))
  } catch {
    /* no storage: ask again next time */
  }
}
