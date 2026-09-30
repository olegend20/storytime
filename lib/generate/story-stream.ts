import { IncrementalJsonScanner } from './json-stream'

/**
 * Maps the incremental JSON scan of a story onto the SSE shape lane 4 renders:
 * one `meta`, then `chapter_start` / `chapter_delta` / `chapter_end` per chapter.
 *
 * Two ordering guarantees the client depends on:
 *  - `meta` is emitted as soon as the title is known, before any prose;
 *  - a chapter's deltas never precede its `chapter_start`. If the model happens to emit
 *    `text` before `heading`, the deltas are held and flushed once the heading arrives (or
 *    once the chapter object closes), rather than arriving orphaned.
 */

export interface StoryStreamHandlers {
  onMeta: (meta: { title: string; subtitle: string | null }) => void
  onChapterStart: (index: number, heading: string) => void
  onChapterDelta: (index: number, text: string) => void
  onChapterEnd: (index: number, shoutLine: string | null) => void
}

const CHAPTER_PATH = /^chapters\[(\d+)\]$/
const CHAPTER_FIELD = /^chapters\[(\d+)\]\.(heading|text|shout_line)$/

export class StoryStreamParser {
  private readonly scanner: IncrementalJsonScanner
  private title: string | null = null
  private subtitleSeen = false
  private subtitle: string | null = null
  private metaEmitted = false
  private readonly started = new Set<number>()
  private readonly ended = new Set<number>()
  private readonly pending = new Map<number, string>()
  private readonly shoutLines = new Map<number, string | null>()
  private raw = ''

  constructor(private readonly handlers: StoryStreamHandlers) {
    this.scanner = new IncrementalJsonScanner({
      onStringEnd: (path, value) => this.onStringEnd(path, value),
      onStringDelta: (path, text) => this.onStringDelta(path, text),
      onScalar: (path, value) => this.onScalar(path, value),
      onArrayStart: (path) => {
        // The chapters array opening means the header fields are done, even if the model
        // omitted `subtitle` entirely.
        if (path === 'chapters') this.maybeEmitMeta(true)
      },
      onObjectEnd: (path) => {
        const match = CHAPTER_PATH.exec(path)
        if (match) this.closeChapter(Number(match[1]))
      },
    })
  }

  /** The concatenated model text, for the authoritative parse once the stream ends. */
  get text(): string {
    return this.raw
  }

  feed(chunk: string): void {
    this.raw += chunk
    this.scanner.feed(chunk)
  }

  /**
   * Flush anything held back and close every chapter still open. Safe to call twice.
   *
   * A truncated response (the model hit max_tokens mid-chapter) leaves the last chapter
   * object unclosed, so nothing would emit its `chapter_end` and the client would render an
   * unfinished chapter forever. Closing here means the stream is always well-formed even
   * when the model's output is not.
   */
  end(): void {
    this.scanner.end()
    this.maybeEmitMeta(true)
    const open = new Set<number>([...this.pending.keys(), ...this.started])
    for (const index of [...open].sort((a, b) => a - b)) {
      this.closeChapter(index)
    }
  }

  private maybeEmitMeta(force: boolean): void {
    if (this.metaEmitted) return
    if (this.title === null) return
    if (!force && !this.subtitleSeen) return
    this.metaEmitted = true
    this.handlers.onMeta({ title: this.title, subtitle: this.subtitle })
  }

  private startChapter(index: number, heading: string): void {
    if (this.started.has(index)) return
    this.started.add(index)
    this.handlers.onChapterStart(index, heading)
    const held = this.pending.get(index)
    if (held !== undefined && held !== '') {
      this.pending.delete(index)
      this.handlers.onChapterDelta(index, held)
    }
    this.pending.delete(index)
  }

  private closeChapter(index: number): void {
    if (this.ended.has(index)) return
    this.startChapter(index, '')
    this.ended.add(index)
    this.handlers.onChapterEnd(index, this.shoutLines.get(index) ?? null)
  }

  private onStringEnd(path: string, value: string): void {
    if (path === 'title') {
      this.title = value
      return
    }
    if (path === 'subtitle') {
      this.subtitle = value
      this.subtitleSeen = true
      this.maybeEmitMeta(false)
      return
    }
    const match = CHAPTER_FIELD.exec(path)
    if (!match) return
    const index = Number(match[1])
    if (match[2] === 'heading') {
      this.maybeEmitMeta(true)
      this.startChapter(index, value)
    } else if (match[2] === 'shout_line') {
      this.shoutLines.set(index, value)
    }
  }

  private onStringDelta(path: string, text: string): void {
    const match = CHAPTER_FIELD.exec(path)
    if (!match || match[2] !== 'text') return
    const index = Number(match[1])
    if (!this.started.has(index)) {
      this.pending.set(index, (this.pending.get(index) ?? '') + text)
      return
    }
    this.handlers.onChapterDelta(index, text)
  }

  private onScalar(path: string, value: unknown): void {
    if (path === 'subtitle' && value === null) {
      this.subtitle = null
      this.subtitleSeen = true
      this.maybeEmitMeta(false)
      return
    }
    const match = CHAPTER_FIELD.exec(path)
    if (match && match[2] === 'shout_line' && value === null) {
      this.shoutLines.set(Number(match[1]), null)
    }
  }
}
