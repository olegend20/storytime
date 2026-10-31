import type { SupabaseClient } from '@supabase/supabase-js'
import type { SseEvent } from '@/lib/schemas'
// The page's own reducer, pure and shared: the snapshot is folded exactly as the page folds the
// live stream, so a chapter the writer restarts after a drop (#74) is handled the same way.
import { initialStreamState, streamReducer, type StreamState } from '@/lib/client/generate'
import { readGenerationRequest, type GenerationRequestView } from './requests'

/**
 * The story so far, for a page that lost its stream (issue #82): the `generation_progress` table.
 *
 * A phone that locks or switches apps loses the story stream while the server keeps writing
 * (#59). Each server request runs on its own, so the returning page cannot rejoin the stream:
 * it reads the snapshot this recorder keeps and carries on from there. Best-effort, like the
 * request record: a failed write is logged and never touches the stream or the story.
 */

/** At most one write this often while prose streams; a chapter is thousands of deltas. */
export const PROGRESS_WRITE_MS = 1_500

/** Rows older than this are deleted when a request starts: long after the route's maxDuration. */
export const PROGRESS_RETENTION_MS = 60 * 60_000

/** Written at once: the page should see a new chapter, the title or the end without waiting. */
function urgent(event: SseEvent): boolean {
  return event.type !== 'chapter_delta' && event.type !== 'chapter_start'
}

/**
 * The stream folded to the fewest events that rebuild the same reader: facts, meta, each
 * chapter as one start, one delta with its whole text and its end once complete, then the
 * terminal event as it was sent - or, once the story is done, facts, meta and `done` alone.
 */
export function compactEvents(state: StreamState, terminal: SseEvent | null): SseEvent[] {
  const events: SseEvent[] = []
  if (state.facts) events.push(state.facts)
  if (state.meta) events.push(state.meta)
  // `done` carries the whole story, and the reader rebuilds every chapter from it: the
  // chapters are not sent twice (code review on #83).
  if (terminal?.type === 'done') return [...events, terminal]
  for (const [index, chapter] of state.chapters.entries()) {
    events.push({ type: 'chapter_start', index, heading: chapter.heading })
    if (chapter.text) events.push({ type: 'chapter_delta', index, text: chapter.text })
    if (chapter.complete) events.push({ type: 'chapter_end', index, shout_line: chapter.shout_line })
  }
  if (terminal) events.push(terminal)
  return events
}

export interface ProgressStats {
  writes: number
  failures: number
  /** Per write: from the first event it carries to the write returning. */
  lagMs: number[]
}

export interface ProgressRecorderOptions {
  writeMs?: number
  now?: () => number
}

export class ProgressRecorder {
  private state: StreamState = { ...initialStreamState, phase: 'streaming' }
  private terminal: SseEvent | null = null
  private version = 0
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private pendingSince: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The write in flight, and the newest snapshot waiting behind it: never more than one. */
  private inFlight: Promise<void> | null = null
  private queued: { version: number; events: SseEvent[]; since: number } | null = null
  /** Set once the table is missing (a deploy before its migration): no more writes are tried. */
  private disabled = false
  readonly stats: ProgressStats = { writes: 0, failures: 0, lagMs: [] }
  private readonly writeMs: number
  private readonly now: () => number

  constructor(
    private readonly db: SupabaseClient,
    private readonly generationId: string,
    private readonly familyId: string,
    opts: ProgressRecorderOptions = {},
  ) {
    this.writeMs = opts.writeMs ?? PROGRESS_WRITE_MS
    this.now = opts.now ?? Date.now
  }

  /** For `SseChannel.onPush`. Never throws and never waits: the write runs behind the stream. */
  observe(event: SseEvent): void {
    this.state = streamReducer(this.state, { kind: 'event', event })
    if (event.type === 'done' || event.type === 'error') this.terminal = event
    this.pendingSince ??= this.now()
    if (urgent(event)) this.flush()
    else this.schedule()
  }

  /** Writes what is still pending and resolves once every write has returned. */
  settled(): Promise<void> {
    if (this.pendingSince !== null) this.flush()
    return this.inFlight ?? Promise.resolve()
  }

  private schedule(): void {
    if (this.timer) return
    const wait = Math.max(0, this.lastWriteAt + this.writeMs - this.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, wait)
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pendingSince === null) return
    const since = this.pendingSince
    this.pendingSince = null
    this.lastWriteAt = this.now()
    this.version += 1
    // Coalesced: a slow database never builds a queue of whole-story copies. The newest snapshot
    // replaces any still waiting, and is written once the write in flight returns, in order, so
    // a version in the table only ever goes up (code review on #83).
    this.queued = { version: this.version, events: compactEvents(this.state, this.terminal), since: this.queued?.since ?? since }
    this.inFlight ??= this.drain()
  }

  private async drain(): Promise<void> {
    // Yield first, so `inFlight` is set before this can finish and clear it.
    await Promise.resolve()
    while (this.queued) {
      const job = this.queued
      this.queued = null
      if (!this.disabled) await this.write(job.version, job.events, job.since)
    }
    this.inFlight = null
  }

  private async write(version: number, events: SseEvent[], since: number): Promise<void> {
    try {
      const { error } = await this.db.from('generation_progress').upsert(
        {
          generation_id: this.generationId,
          family_id: this.familyId,
          version,
          events,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'generation_id' },
      )
      if (error) {
        this.stats.failures += 1
        console.warn(`[generate] generation_progress write: ${error.message}`)
        if (error.code === '42P01' || /does not exist/i.test(error.message)) this.disabled = true
        return
      }
      this.stats.writes += 1
      this.stats.lagMs.push(this.now() - since)
    } catch (err) {
      this.stats.failures += 1
      console.warn('[generate] generation_progress write threw:', err)
    }
  }
}

/** Deletes snapshots past their use. Best-effort: run when a request starts, never awaited by a story. */
export async function pruneGenerationProgress(db: SupabaseClient, now: number = Date.now()): Promise<void> {
  try {
    const { error } = await db
      .from('generation_progress')
      .delete()
      .lt('updated_at', new Date(now - PROGRESS_RETENTION_MS).toISOString())
    if (error) console.warn(`[generate] generation_progress prune: ${error.message}`)
  } catch (err) {
    console.warn('[generate] generation_progress prune threw:', err)
  }
}

export interface GenerationProgressView extends GenerationRequestView {
  /** 0 before the first snapshot. */
  version: number
  /** The snapshot, only when it is newer than the version the page has. */
  events: SseEvent[] | null
}

/**
 * One family's request and, when the page is behind, its story so far. Null when there is no
 * such request for this family. How the request ended follows #59 (`readGenerationRequest`),
 * and is answered even when the snapshot cannot be read.
 */
export async function readGenerationProgress(
  db: SupabaseClient,
  familyId: string,
  id: string,
  after: number,
  now: number = Date.now(),
): Promise<GenerationProgressView | null> {
  const request = await readGenerationRequest(db, familyId, id, now)
  if (!request) return null
  const { data, error } = await db
    .from('generation_progress')
    .select('version, events')
    .eq('generation_id', id.toLowerCase())
    .eq('family_id', familyId)
    .maybeSingle()
  if (error) {
    // The #59 answer still stands without the story so far (a table not yet migrated, a
    // read that failed): the page then opens the saved story, as it did before #82.
    console.warn(`[generate] generation_progress read: ${error.message}`)
    return { ...request, version: 0, events: null }
  }
  const row = data as { version: number; events: SseEvent[] } | null
  const version = row?.version ?? 0
  return { ...request, version, events: row && version > after ? row.events : null }
}
