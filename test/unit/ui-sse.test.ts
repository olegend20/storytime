import { describe, expect, it } from 'vitest'
import { SseFrameParser, readSseFrames, sseFrame } from '@/lib/client/sse'

/**
 * The SSE framing layer. `lib/schemas/api.ts` requires the client to tolerate unknown event
 * types, and that tolerance is worthless if the framing itself breaks on a chunk boundary -
 * which is the one thing that is guaranteed to happen in production and never happens locally.
 */
describe('SseFrameParser', () => {
  it('emits one payload per frame', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data: {"a":1}\n\ndata: {"a":2}\n\n')).toEqual(['{"a":1}', '{"a":2}'])
  })

  it('holds a frame split across chunks until it is complete', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data: {"ty')).toEqual([])
    expect(parser.push('pe":"meta"}')).toEqual([])
    expect(parser.push('\n\n')).toEqual(['{"type":"meta"}'])
  })

  it('splits correctly when the blank line itself straddles two chunks', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data: 1\n')).toEqual([])
    expect(parser.push('\ndata: 2\n\n')).toEqual(['1', '2'])
  })

  it('normalizes CRLF', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data: {"a":1}\r\n\r\n')).toEqual(['{"a":1}'])
  })

  it('ignores keep-alive comments and non-data fields', () => {
    const parser = new SseFrameParser()
    const frames = parser.push(': ping\n\nevent: message\nid: 7\ndata: {"a":1}\n\nretry: 100\n\n')
    expect(frames).toEqual(['{"a":1}'])
  })

  it('joins multi-line data with newlines', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data: line one\ndata: line two\n\n')).toEqual(['line one\nline two'])
  })

  it('keeps a data value that is empty', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data:\n\n')).toEqual([''])
  })

  it('flushes a final frame that had no trailing blank line', () => {
    const parser = new SseFrameParser()
    expect(parser.push('data: {"a":1}')).toEqual([])
    expect(parser.flush()).toEqual(['{"a":1}'])
  })

  it('flushes nothing for trailing whitespace', () => {
    const parser = new SseFrameParser()
    parser.push('data: 1\n\n')
    expect(parser.flush()).toEqual([])
  })
})

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  })
}

describe('readSseFrames', () => {
  it('reads a whole stream', async () => {
    const body = new TextEncoder().encode(sseFrame({ type: 'a' }) + sseFrame({ type: 'b' }))
    const frames: string[] = []
    for await (const frame of readSseFrames(streamOf([body]))) frames.push(frame)
    expect(frames.map((f) => JSON.parse(f))).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('survives a multi-byte character split across two chunks', async () => {
    // "café" — the é is two bytes, and we cut between them.
    const bytes = new TextEncoder().encode(sseFrame({ text: 'café' }))
    const cut = bytes.indexOf(0xc3) + 1
    const frames: string[] = []
    for await (const frame of readSseFrames(streamOf([bytes.slice(0, cut), bytes.slice(cut)]))) {
      frames.push(frame)
    }
    expect(JSON.parse(frames[0] ?? '{}')).toEqual({ text: 'café' })
  })

  it('stops when the signal is aborted', async () => {
    const body = new TextEncoder().encode(sseFrame({ type: 'a' }))
    const controller = new AbortController()
    controller.abort()
    const frames: string[] = []
    for await (const frame of readSseFrames(streamOf([body]), controller.signal)) frames.push(frame)
    expect(frames).toEqual([])
  })
})
