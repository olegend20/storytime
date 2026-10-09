import { sseFrame } from '@/lib/client/sse'
import type { LibraryStory } from '@/lib/client/types'
import { storyWordCount, targetWords, type QualityResult, type SseEvent } from '@/lib/schemas'
import { midstreamErrorEvent, type MockScenario } from './scenarios'

/**
 * Replays a stored story as the SSE stream `lib/schemas/api.ts` describes:
 * `meta` -> per chapter (`chapter_start`, `chapter_delta`*, `chapter_end`) -> `done` | `error`.
 *
 * Progressive by construction: chapter bodies are cut into small pieces at word boundaries, so
 * the reader is exercised the way a real generation exercises it, including a heading arriving
 * before its prose.
 */

/** Small enough that a chapter takes several frames; large enough to keep e2e quick. */
const CHUNK_CHARS = 64

export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = []
  let current = ''
  // Keep the trailing whitespace with each token so joining the chunks is lossless.
  for (const token of text.split(/(?<=\s)/)) {
    if (current.length + token.length > size && current !== '') {
      chunks.push(current)
      current = ''
    }
    current += token
  }
  if (current !== '') chunks.push(current)
  return chunks
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mockQuality(story: LibraryStory): QualityResult {
  const target = targetWords({ band: story.age_band, minutes: story.length_minutes })
  return {
    outcome: 'pass',
    attempt: 1,
    deterministic_passed: true,
    failures: [],
    review: {
      age_appropriate: true,
      scary_level: 0,
      kids_are_active_participants: true,
      facts_consistent_with_pack: true,
      tone_matches_request: true,
      reasons: [],
    },
    safety: {
      safe: true,
      violations: [],
      scary_level: 0,
      positive_portrayal: true,
      ending_safe: true,
    },
    hard_violations: [],
    rewrite_reasons: [],
    word_count: storyWordCount(story.content),
    target_words: target,
  }
}

/** How long the `thinking` scenario holds the stream between the facts and the first chapter. */
export const MOCK_THINKING_MS = 4_000

export interface StreamOptions {
  scenario: MockScenario
  delayMs: number
  quota: { used: number; limit: number }
}

/**
 * Build the event sequence. Separated from the timing so a test can assert the order and the
 * payloads without waiting on any of it.
 */
export function generationEvents(story: LibraryStory, opts: StreamOptions): unknown[] {
  const target = targetWords({ band: story.age_band, minutes: story.length_minutes })
  const events: unknown[] = []
  // The real pipeline sends the fact pack's facts before the writer starts. The mock has no
  // pack, so the story's own True Facts stand in - the same shape the cards render.
  events.push({
    type: 'facts',
    topic_label: story.topic_label,
    facts: story.content.true_facts.slice(0, 12).map((f) => ({ id: f.fact_id, text: f.text })),
  } satisfies SseEvent)
  const meta: SseEvent = {
    type: 'meta',
    story_id: story.id,
    series_id: story.series_id,
    title: story.content.title,
    subtitle: story.content.subtitle,
    age_band: story.age_band,
    target_words: target,
    topic_label: story.topic_label,
    content_notice: story.content_notice,
  }
  events.push(meta)

  if (opts.scenario === 'unknown_event') {
    // A type this build has never seen. The contract requires the client to ignore it.
    events.push({ type: 'writer_note', note: 'lane 2 added an event type', index: 0 })
  }

  const failAfter = opts.scenario === 'midstream_failure' ? 2 : Number.POSITIVE_INFINITY
  for (const [index, chapter] of story.content.chapters.entries()) {
    // The stream simply ends: what a parent's browser sees when the connection drops.
    if (opts.scenario === 'connection_dropped' && index >= 2) return events
    if (index >= failAfter) {
      events.push(midstreamErrorEvent())
      return events
    }
    events.push({ type: 'chapter_start', index, heading: chapter.heading })
    for (const text of chunkText(chapter.text)) {
      events.push({ type: 'chapter_delta', index, text })
    }
    events.push({ type: 'chapter_end', index, shout_line: chapter.shout_line })
  }

  events.push({
    type: 'done',
    story_id: story.id,
    story: story.content,
    quality: mockQuality(story),
    word_count: storyWordCount(story.content),
    quota: opts.quota,
  })
  return events
}

/** The SSE response body. */
export function generationStream(story: LibraryStory, opts: StreamOptions): ReadableStream<Uint8Array> {
  const events = generationEvents(story, opts)
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const event = events[i++]
      if (event === undefined) {
        controller.close()
        return
      }
      if (opts.delayMs > 0) await sleep(opts.delayMs)
      // The real writer thinks for ~2 minutes between the facts and chapter 1.
      if (opts.scenario === 'thinking' && (event as { type?: string }).type === 'meta') {
        await sleep(MOCK_THINKING_MS)
      }
      controller.enqueue(encoder.encode(sseFrame(event)))
    },
  })
}

export function sseHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Vercel and most proxies buffer without this; a buffered SSE stream is not a stream.
    'x-accel-buffering': 'no',
  }
}
