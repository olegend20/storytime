import {
  ErrorBody,
  GenerateStoryBody,
  SseEvent,
  StoryOutput,
  type Chapter,
  type QualityResult,
} from '@/lib/schemas'
import { apiUrl } from './api'
import { readSseFrames } from './sse'

/**
 * Client driver for `POST /api/stories/generate` (§6 F6 / F10).
 *
 * Two failure shapes, per `lib/schemas/api.ts`:
 *  - BEFORE the stream opens: a JSON body with a real HTTP status (429/422/503/400).
 *  - AFTER it opens: an `error` event on a 200.
 * Both land in `StreamState.error` so the UI has one place to render, and both carry
 * `quota_consumed` so a parent is never told they lost a story when they did not.
 */

export type MetaEvent = Extract<SseEvent, { type: 'meta' }>
export type FactsEvent = Extract<SseEvent, { type: 'facts' }>
export type ErrorEvent = Extract<SseEvent, { type: 'error' }>

/** A chapter as it exists mid-stream: heading known, prose still arriving. */
export interface StreamingChapter extends Chapter {
  complete: boolean
}

export interface StreamState {
  phase: 'idle' | 'connecting' | 'streaming' | 'done' | 'error'
  /** The fact cards, sent before the writer starts. Null until then. */
  facts: FactsEvent | null
  meta: MetaEvent | null
  chapters: StreamingChapter[]
  /** Final story from the `done` event, when it validated. Null while streaming. */
  story: StoryOutput | null
  quality: QualityResult | null
  wordCount: number | null
  quota: { used: number; limit: number } | null
  error: ErrorBody | null
  /**
   * Count of events whose `type` this build does not know. Not an error - the contract
   * requires tolerating them. Surfaced only so a test can assert we stayed silent.
   */
  unknownEvents: number
}

export const initialStreamState: StreamState = {
  phase: 'idle',
  facts: null,
  meta: null,
  chapters: [],
  story: null,
  quality: null,
  wordCount: null,
  quota: null,
  error: null,
  unknownEvents: 0,
}

export type StreamAction =
  | { kind: 'start' }
  /** Back to the form after a failure, discarding the partial story. */
  | { kind: 'reset' }
  | { kind: 'event'; event: SseEvent }
  | { kind: 'unknown' }
  | { kind: 'fail'; error: ErrorBody }

const EMPTY_CHAPTER: StreamingChapter = { heading: '', text: '', shout_line: null, complete: false }

function withChapter(
  chapters: StreamingChapter[],
  index: number,
  patch: (c: StreamingChapter) => StreamingChapter,
): StreamingChapter[] {
  const next = [...chapters]
  while (next.length <= index) next.push({ ...EMPTY_CHAPTER })
  const current = next[index] ?? { ...EMPTY_CHAPTER }
  next[index] = patch(current)
  return next
}

export function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.kind) {
    case 'start':
      return { ...initialStreamState, phase: 'connecting' }
    case 'reset':
      return { ...initialStreamState }
    case 'unknown':
      return { ...state, unknownEvents: state.unknownEvents + 1 }
    case 'fail':
      return { ...state, phase: 'error', error: action.error }
    case 'event':
      break
  }
  const event = action.event
  switch (event.type) {
    case 'facts':
      return { ...state, phase: 'streaming', facts: event }
    case 'meta':
      return { ...state, phase: 'streaming', meta: event }
    case 'chapter_start':
      return {
        ...state,
        phase: 'streaming',
        chapters: withChapter(state.chapters, event.index, (c) => ({
          ...c,
          heading: event.heading,
        })),
      }
    case 'chapter_delta':
      return {
        ...state,
        phase: 'streaming',
        chapters: withChapter(state.chapters, event.index, (c) => ({
          ...c,
          text: c.text + event.text,
        })),
      }
    case 'chapter_end':
      return {
        ...state,
        chapters: withChapter(state.chapters, event.index, (c) => ({
          ...c,
          shout_line: event.shout_line,
          complete: true,
        })),
      }
    case 'done': {
      // The reader keeps rendering from `chapters` if `done.story` ever drifts from the
      // schema, so a server-side change can degrade the facts list but never blank the story.
      const parsed = StoryOutput.safeParse(event.story)
      if (!parsed.success && typeof console !== 'undefined') {
        console.warn('[storytime] done.story failed StoryOutput validation; using stream state')
      }
      const story = parsed.success ? parsed.data : null
      return {
        ...state,
        phase: 'done',
        story,
        quality: event.quality,
        wordCount: event.word_count,
        quota: event.quota,
        chapters: story
          ? story.chapters.map((c) => ({ ...c, complete: true }))
          : state.chapters.map((c) => ({ ...c, complete: true })),
      }
    }
    case 'error':
      return {
        ...state,
        phase: 'error',
        error: {
          code: event.code,
          message: event.message,
          quota_consumed: event.quota_consumed,
          resets_at: event.resets_at,
        },
      }
    default:
      // Unreachable for known types; an added event type arrives here as `unknown` instead.
      return state
  }
}

/**
 * 0..1 progress, or null when there is nothing honest to show yet.
 *
 * Words-against-target rather than chapters-against-count: the chapter count is not known
 * until the story ends, but `meta.target_words` arrives in the first event. Capped below 1
 * so the bar never sits full while prose is still arriving.
 */
export function streamProgress(state: StreamState): number | null {
  if (state.phase === 'done') return 1
  if (!state.meta) return null
  const target = (state.meta.target_words.min + state.meta.target_words.max) / 2
  if (target <= 0) return null
  const words = state.chapters.reduce((n, c) => n + countWords(c.text), 0)
  return Math.min(0.97, words / target)
}

function countWords(text: string): number {
  const t = text.trim()
  return t === '' ? 0 : t.split(/\s+/).length
}

/**
 * The reassurance F10's AC requires, shown only when the failure genuinely cost nothing.
 *
 * Refusal wording itself belongs to `config/guardrails/messages.json` (lane 6) and is
 * rendered verbatim; this is a quota statement, which is the UI's to make. Suppressed when
 * the server message already says it, so the parent never reads it twice.
 */
export function needsFreeRetryNote(error: ErrorBody): boolean {
  if (error.quota_consumed) return false
  const normalized = error.message.toLowerCase().replace(/[‘’]/g, "'")
  return !normalized.includes("didn't use one of your stories")
}

export const FREE_RETRY_NOTE = "Try again — this didn't use one of your stories."

/** What went wrong, before the stream opened. */
function fallbackError(code: string, message: string): ErrorBody {
  return { code, message, quota_consumed: false, resets_at: null }
}

export interface StartStreamResult {
  ok: boolean
  stream: ReadableStream<Uint8Array> | null
  error: ErrorBody | null
}

/** POST the request; separate the pre-stream failure case from the stream case. */
export async function startGeneration(
  body: GenerateStoryBody,
  signal?: AbortSignal,
): Promise<StartStreamResult> {
  let res: Response
  try {
    res = await fetch(apiUrl('/stories/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: signal ?? null,
    })
  } catch {
    return {
      ok: false,
      stream: null,
      error: fallbackError(
        'network_error',
        "We couldn't reach StoryTime just now. Check your connection and try again.",
      ),
    }
  }

  if (!res.ok) {
    let parsed: ErrorBody | null = null
    try {
      parsed = ErrorBody.parse(await res.json())
    } catch {
      parsed = null
    }
    return {
      ok: false,
      stream: null,
      error:
        parsed ??
        fallbackError(
          'generation_failed',
          "Something went wrong on our side. Please try again in a moment.",
        ),
    }
  }

  if (!res.body) {
    return {
      ok: false,
      stream: null,
      error: fallbackError('generation_failed', 'The story stream did not open. Please try again.'),
    }
  }
  return { ok: true, stream: res.body, error: null }
}

/**
 * Yield validated events from an open stream. Unknown or malformed events yield
 * `{ kind: 'unknown' }` instead of throwing - a deployed frontend must survive lane 2
 * adding an event type.
 */
export async function* readGenerationEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamAction> {
  for await (const frame of readSseFrames(stream, signal)) {
    let raw: unknown
    try {
      raw = JSON.parse(frame)
    } catch {
      yield { kind: 'unknown' }
      continue
    }
    const parsed = SseEvent.safeParse(raw)
    if (parsed.success) yield { kind: 'event', event: parsed.data }
    else yield { kind: 'unknown' }
  }
}
