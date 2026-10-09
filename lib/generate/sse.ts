import { SseEvent } from '@/lib/schemas'

/**
 * SSE plumbing for `/api/stories/generate`.
 *
 * The queue exists to honour one awkward but important line of the contract: a failure
 * BEFORE the stream opens is a JSON body with the real HTTP status (502, 429, 422...), and a
 * failure AFTER it is an `error` event on a 200. So the route must know whether any bytes
 * have been committed before it decides what to return - `waitForOpen()` is that decision
 * point.
 */

export function encodeSse(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** Dev/test guard: an event that does not match the contract is a bug in lane 2, not lane 4. */
export function assertSseEvent(event: SseEvent): SseEvent {
  const parsed = SseEvent.safeParse(event)
  if (!parsed.success) {
    throw new Error(
      `SSE event does not match lib/schemas/api.ts: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
  }
  return event
}

type Waiter = () => void

export class SseChannel {
  private readonly buffer: SseEvent[] = []
  private waiters: Waiter[] = []
  private closed = false
  private preStreamError: unknown = null
  private openResolve: (() => void) | null = null
  private openReject: ((err: unknown) => void) | null = null
  private opened = false
  private readonly openPromise: Promise<void>

  constructor(private readonly validate = true) {
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve
      this.openReject = reject
    })
    // A caller that never awaits `waitForOpen()` must not leave an unhandled rejection.
    this.openPromise.catch(() => {})
  }

  /** True once at least one event has been queued: the response is committed to 200 + SSE. */
  get isOpen(): boolean {
    return this.opened
  }

  push(event: SseEvent): void {
    if (this.closed) return
    if (this.validate) assertSseEvent(event)
    this.buffer.push(event)
    if (!this.opened) {
      this.opened = true
      this.openResolve?.()
    }
    this.wake()
  }

  /**
   * A failure with nothing yet sent. Rejects `waitForOpen()` so the route can answer with
   * the real HTTP status instead of a 200 stream carrying an error event.
   */
  fail(error: unknown): void {
    if (this.opened || this.closed) {
      this.close()
      return
    }
    this.preStreamError = error
    this.closed = true
    this.openReject?.(error)
    this.wake()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (!this.opened) {
      this.opened = true
      this.openResolve?.()
    }
    this.wake()
  }

  /** Resolves when the first event is queued; rejects when the run failed pre-stream. */
  waitForOpen(): Promise<void> {
    return this.openPromise
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }

  async *events(): AsyncGenerator<SseEvent> {
    for (;;) {
      while (this.buffer.length > 0) yield this.buffer.shift()!
      if (this.closed) {
        if (this.preStreamError) throw this.preStreamError
        return
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  /**
   * The wire form. `heartbeatMs`: while no event is ready, an SSE comment line is sent at
   * this interval. A phone, a carrier or a proxy drops a connection that has been silent for
   * about a minute, and a story has silent minutes - a new topic's fact pack, a rewrite.
   * The client's parser skips comment lines (lib/client/sse.ts).
   */
  toReadableStream(heartbeatMs = 0): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const iterator = this.events()
    // The `next()` still in flight from an earlier pull that a heartbeat won: never dropped.
    let pending: Promise<IteratorResult<SseEvent>> | null = null
    const HEARTBEAT = Symbol('heartbeat')
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        pending ??= iterator.next()
        let timer: ReturnType<typeof setTimeout> | undefined
        const next =
          heartbeatMs > 0
            ? await Promise.race([
                pending,
                new Promise<typeof HEARTBEAT>((r) => {
                  timer = setTimeout(() => r(HEARTBEAT), heartbeatMs)
                }),
              ])
            : await pending
        // A chapter is thousands of events: a timer per pull must not outlive its pull.
        if (timer !== undefined) clearTimeout(timer)
        if (next === HEARTBEAT) {
          controller.enqueue(encoder.encode(': keep-alive\n\n'))
          return
        }
        pending = null
        if (next.done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(encodeSse(next.value)))
      },
      cancel: () => {
        this.close()
      },
    })
  }
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Vercel/nginx must not buffer a story stream, or progressive rendering dies silently.
  'X-Accel-Buffering': 'no',
}
