/**
 * Incremental SSE frame parser.
 *
 * `EventSource` cannot POST, and `/api/stories/generate` is a POST (§6 F6), so the client
 * reads `response.body` itself. Network chunks split anywhere - mid-frame, mid-line, even
 * mid-UTF-8-sequence - so framing has to be a stateful push parser rather than a split on
 * the whole body.
 *
 * Deliberately permissive, because `lib/schemas/api.ts` says "the client must tolerate
 * unknown `type` values so lane 2 can add events without breaking a deployed frontend":
 * comments, `event:` / `id:` / `retry:` fields and unparseable JSON are skipped, never
 * thrown. Type filtering happens one layer up, in `generate.ts`.
 */

export class SseFrameParser {
  private buffer = ''

  /** Feed a decoded chunk; returns the `data` payload of every frame it completed. */
  push(chunk: string): string[] {
    // Normalize CRLF and lone CR so the frame delimiter is always "\n\n".
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const out: string[] = []
    let sep = this.buffer.indexOf('\n\n')
    while (sep !== -1) {
      const frame = this.buffer.slice(0, sep)
      this.buffer = this.buffer.slice(sep + 2)
      const data = dataOf(frame)
      if (data !== null) out.push(data)
      sep = this.buffer.indexOf('\n\n')
    }
    return out
  }

  /** Flush a final frame that the stream ended without a blank line after. */
  flush(): string[] {
    const rest = this.buffer
    this.buffer = ''
    if (rest.trim() === '') return []
    const data = dataOf(rest)
    return data === null ? [] : [data]
  }
}

/** Concatenate the `data:` lines of one frame. Returns null for a frame with no data. */
function dataOf(frame: string): string | null {
  const parts: string[] = []
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue // keep-alive comment
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== 'data') continue // event: / id: / retry: / anything new
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    parts.push(value)
  }
  if (parts.length === 0) return null
  return parts.join('\n')
}

/** Read a fetch body to completion, yielding one JSON string per SSE frame. */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader()
  // `stream: true` matters: a multi-byte character can straddle two chunks.
  const decoder = new TextDecoder()
  const parser = new SseFrameParser()
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) yield frame
    }
    for (const frame of parser.push(decoder.decode())) yield frame
    for (const frame of parser.flush()) yield frame
  } finally {
    reader.releaseLock()
  }
}

/** Serialize one event as an SSE frame. Used by the mock server and its tests. */
export function sseFrame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}
