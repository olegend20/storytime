import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureKey, writeFixture } from '@/lib/ai/fixtures'
import { modelForRole } from '@/lib/ai/pricing'
import { MemoryLogSink } from '@/lib/ai/types'
import { classifierSystemPrompt, classifierUserMessage } from '@/lib/guardrails/classify'
import { MemoryGuardrailSink, setGuardrailSink } from '@/lib/guardrails/events'
import { guardInput } from '@/lib/guardrails/input'
import { messages } from '@/lib/guardrails/messages'
import { reviewOutput, reviewSystemPrompt, reviewUserMessage } from '@/lib/guardrails/review'
import type { InputClassification } from '@/lib/schemas/guardrail'

/**
 * L2 WIRING, not L2 quality.
 *
 * The classifier's answers here are fabricated: this file proves that whatever the model
 * says is parsed, age-band-enforced, logged and turned into the right parent-facing copy,
 * and that an L2 refusal still writes no `write` log row. It measures nothing about how
 * well Haiku classifies - that is `test/guardrails/corpus-l2.test.ts`, which needs
 * recorded fixtures.
 *
 * Fabricated payloads go to the temp FIXTURE_DIR that test/setup.ts creates, so
 * `test/fixtures/model/` stays reserved for fixtures recorded from real responses
 * (kickoff rule 3).
 */

const events = new MemoryGuardrailSink()
const logs = new MemoryLogSink()

beforeEach(() => {
  events.clear()
  logs.clear()
  setGuardrailSink(events)
})
afterEach(() => setGuardrailSink(new MemoryGuardrailSink()))

/** Mirrors exactly what callModel() sends for a classify_input call. */
function stubClassifier(
  input: { topic: string; likes?: string[]; notes?: string | null; youngestAge: number },
  answer: InputClassification,
): void {
  const model = modelForRole('helper')
  const system = [
    {
      type: 'text',
      text: classifierSystemPrompt(),
      cache_control: { type: 'ephemeral' },
    },
  ]
  const messagesParam = [{ role: 'user', content: classifierUserMessage(input) }]
  const key = fixtureKey({ model, system, messages: messagesParam, max_tokens: 700 })
  writeFixture('classify_input', key, {
    purpose: 'classify_input',
    model,
    response: { content: [{ type: 'text', text: JSON.stringify(answer) }] },
    usage: { input_tokens: 900, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 120 },
    stop_reason: 'end_turn',
    recorded_at: new Date().toISOString(),
  })
}

const allow: InputClassification = {
  decision: 'allow',
  category: 'educational',
  care_notes: null,
  min_recommended_age: 4,
  topic_key_hint: 'how-bees-make-honey',
  parent_message: null,
}

describe('L2 wiring through guardInput', () => {
  it('passes an allowed topic through with its topic key hint', async () => {
    const input = { topic: 'how bees make honey', likes: [], notes: null, youngestAge: 4 }
    stubClassifier(input, allow)
    const result = await guardInput({
      topic_input: input.topic,
      youngestAge: 4,
      sink: logs,
    })
    expect(result.decision).toBe('allow')
    expect(result.topicKeyHint).toBe('how-bees-make-honey')
    expect(result.modelCalls).toBe(1)
    expect(events.events).toHaveLength(0)
  })

  it('carries care_notes through on allow_with_care', async () => {
    const input = { topic: 'the Titanic', likes: [], notes: null, youngestAge: 7 }
    stubClassifier(input, {
      ...allow,
      decision: 'allow_with_care',
      care_notes: 'Focus on the engineering and the rescue; do not describe drowning.',
      min_recommended_age: 7,
      topic_key_hint: 'the-titanic',
    })
    const result = await guardInput({ topic_input: input.topic, youngestAge: 7, sink: logs })
    expect(result.decision).toBe('allow_with_care')
    expect(result.careNotes).toContain('rescue')
  })

  it('turns the same answer into too_mature_for_band for a younger child', async () => {
    const input = { topic: 'the Titanic', likes: [], notes: null, youngestAge: 4 }
    stubClassifier(input, {
      ...allow,
      decision: 'allow_with_care',
      care_notes: 'Focus on the engineering.',
      min_recommended_age: 7,
      topic_key_hint: 'the-titanic',
    })
    const result = await guardInput({
      topic_input: input.topic,
      youngestAge: 4,
      youngestName: 'Juno',
      sink: logs,
    })
    expect(result.decision).toBe('refuse')
    expect(result.category).toBe('too_mature_for_band')
    expect(result.parentMessage).toContain('4-year-old')
    expect(result.parentMessage).toContain('Juno')
    expect(events.events[0]?.layer).toBe('L2')
  })

  it('logs an L2 refusal and writes no `write` generation_logs row', async () => {
    const input = { topic: 'a Peppa Pig bedtime story', likes: [], notes: null, youngestAge: 4 }
    stubClassifier(input, {
      decision: 'refuse',
      category: 'commercial_ip_character',
      care_notes: null,
      min_recommended_age: 4,
      topic_key_hint: null,
      parent_message: null,
    })
    const result = await guardInput({ topic_input: input.topic, youngestAge: 4, sink: logs })
    expect(result.decision).toBe('refuse')
    expect(result.layer).toBe('L2')
    expect(result.parentMessage).toBe(messages.refuse.commercial_ip_character)
    expect(events.events[0]?.category).toBe('commercial_ip_character')
    expect(events.events[0]?.input_hash).toHaveLength(64)
    // The only model call is the cheap classifier; nothing reaches the writing model.
    expect(logs.rows.map((r) => r.purpose)).toEqual(['classify_input'])
  })

  it('fails closed on an unparseable L4 safety review, and never trusts safe:true over a hard violation', async () => {
    const model = modelForRole('helper')
    const reviewInput = {
      storyText: 'A calm story about bees.',
      band: 'A' as const,
      childNames: ['Milo'],
    }
    const system = [
      { type: 'text', text: reviewSystemPrompt(), cache_control: { type: 'ephemeral' } },
    ]
    const messagesParam = [{ role: 'user', content: reviewUserMessage(reviewInput) }]
    const key = fixtureKey({ model, system, messages: messagesParam, max_tokens: 1500 })

    const write = (text: string): void => {
      writeFixture('safety_review', key, {
        purpose: 'safety_review',
        model,
        response: { content: [{ type: 'text', text }] },
        usage: {
          input_tokens: 2000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          output_tokens: 60,
        },
        stop_reason: 'end_turn',
        recorded_at: new Date().toISOString(),
      })
    }

    write('sorry, no JSON here')
    const failClosed = await reviewOutput({ ...reviewInput, sink: logs })
    expect(failClosed.degraded).toBe(true)
    expect(failClosed.review.safe).toBe(false)
    expect(failClosed.review.scary_level).toBe(3)

    write(
      JSON.stringify({
        safe: true,
        violations: [{ rule: 2, quote: 'covered in blood', severity: 'hard' }],
        scary_level: 0,
        positive_portrayal: true,
        ending_safe: true,
      }),
    )
    const contradictory = await reviewOutput({ ...reviewInput, sink: logs })
    expect(contradictory.review.safe).toBe(false)
  })

  it('fails closed when the classifier returns unparseable JSON', async () => {
    const input = { topic: 'volcanoes and lava', likes: [], notes: null, youngestAge: 6 }
    const model = modelForRole('helper')
    const system = [
      { type: 'text', text: classifierSystemPrompt(), cache_control: { type: 'ephemeral' } },
    ]
    const messagesParam = [{ role: 'user', content: classifierUserMessage(input) }]
    writeFixture(
      'classify_input',
      fixtureKey({ model, system, messages: messagesParam, max_tokens: 700 }),
      {
        purpose: 'classify_input',
        model,
        response: { content: [{ type: 'text', text: 'I am not JSON at all.' }] },
        usage: { input_tokens: 900, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 10 },
        stop_reason: 'end_turn',
        recorded_at: new Date().toISOString(),
      },
    )
    const result = await guardInput({ topic_input: input.topic, youngestAge: 6, sink: logs })
    expect(result.decision).toBe('refuse')
    expect(result.internalReason).toBe('l2_unparseable_fail_closed')
    expect(result.parentMessage).toBe(messages.refuse.other)
  })
})
