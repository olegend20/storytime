import { describe, expect, it } from 'vitest'
import { SseChannel } from '@/lib/generate/sse'
import { SseFrameParser } from '@/lib/client/sse'

/**
 * 2026-10-08: a phone gave up on a story request after ~a minute of silence while a new
 * topic's fact pack was built, though the story was made. A silent stream now sends a
 * comment line at an interval, and no event is ever lost to the race with the timer.
 */
describe('a silent story stream keeps the connection alive', () => {
  it('sends a comment while nothing is ready, then the event itself, then closes', async () => {
    const channel = new SseChannel()
    const reader = channel.toReadableStream(20).getReader()
    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    expect(first).toBe(': keep-alive\n\n')
    channel.push({ type: 'facts', topic_label: 'Sharks', facts: [] })
    // Keep reading until the event: it was not dropped when a heartbeat won the race.
    let text = ''
    for (let i = 0; i < 10 && !text.includes('"type":"facts"'); i++) text += decoder.decode((await reader.read()).value)
    expect(text).toContain('"type":"facts"')
    channel.close()
    let done = false
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done
    expect(done).toBe(true)
  })

  it('the client parser skips the comment lines', () => {
    const frames = new SseFrameParser().push(': keep-alive\n\ndata: {"type":"facts"}\n\n: keep-alive\n\n')
    expect(frames).toEqual(['{"type":"facts"}'])
  })

  it('no interval, no comment lines (the default for every other caller)', async () => {
    const channel = new SseChannel()
    const reader = channel.toReadableStream().getReader()
    channel.push({ type: 'facts', topic_label: 'Sharks', facts: [] })
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"facts"')
  })
})
