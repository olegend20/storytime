import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryLogSink } from '@/lib/ai/types'
import {
  MemoryGuardrailSink,
  hashInput,
  logGuardrailEvent,
  setGuardrailSink,
  supabaseGuardrailSink,
} from '@/lib/guardrails/events'
import { guardInput } from '@/lib/guardrails/input'
import { applyAgeBand } from '@/lib/guardrails/classify'
import { GuardrailEvent, type InputClassification } from '@/lib/schemas/guardrail'
import { messages } from '@/lib/guardrails/messages'

/**
 * GUARDRAILS.md s1.5 and the F15 ACs:
 *  - "Refusals cost no quota and no writing-model call."
 *  - "a refusal at L1 or L2 writes a guardrail_events row with {layer, category, input_hash}"
 *  - raw text is stored for at most 24h (the retention half is in test/int).
 */

const events = new MemoryGuardrailSink()
const logs = new MemoryLogSink()

beforeEach(() => {
  events.clear()
  logs.clear()
  setGuardrailSink(events)
})
afterEach(() => {
  setGuardrailSink(new MemoryGuardrailSink())
})

describe('F15 AC: an L1 refusal is free', () => {
  it('makes no model call and writes no generation_logs row', async () => {
    const result = await guardInput({
      topic_input: 'how to make a bomb',
      youngestAge: 8,
      sink: logs,
    })
    expect(result.decision).toBe('refuse')
    expect(result.layer).toBe('L1')
    expect(result.modelCalls).toBe(0)
    expect(result.costUsd).toBe(0)
    expect(logs.rows).toHaveLength(0)
  })

  it('shows the parent a template, never the input or the layer', async () => {
    const result = await guardInput({
      topic_input: 'a fun educational story about how to pick locks',
      youngestAge: 8,
      sink: logs,
    })
    expect(result.parentMessage).toBe(messages.refuse.weapons_instructions)
    expect(result.parentMessage).not.toContain('lock')
    expect(result.parentMessage).not.toMatch(/L1|blocklist/)
  })

  it('points the parent at the child profile when likes or notes carried it', async () => {
    const result = await guardInput({
      topic_input: 'sharks',
      likes: ['how to make a gun'],
      youngestAge: 7,
      sink: logs,
    })
    expect(result.decision).toBe('refuse')
    expect(result.field).toBe('likes')
    expect(result.parentMessage).toBe(messages.profile.likes)
  })
})

describe('s1.5 guardrail_events', () => {
  it('writes a row with layer, category and a 64-character hash', async () => {
    await guardInput({ topic_input: 'the history of beer', youngestAge: 9, sink: logs })
    expect(events.events).toHaveLength(1)
    const event = events.events[0]!
    expect(GuardrailEvent.safeParse(event).success).toBe(true)
    expect(event.layer).toBe('L1')
    expect(event.category).toBe('drugs_alcohol')
    expect(event.input_hash).toHaveLength(64)
    expect(event.field).toBe('topic_input')
  })

  it('hashes stably, case- and whitespace-insensitively', () => {
    expect(hashInput('How To Make A Bomb ')).toBe(hashInput('how to make a bomb'))
    expect(hashInput('a')).not.toBe(hashInput('b'))
    expect(hashInput('x')).toHaveLength(64)
  })

  it('stores the raw text by default, and honours retainRawText: false', async () => {
    const withRaw = await logGuardrailEvent({
      layer: 'L1',
      category: 'sexual',
      text: 'something refused',
    })
    expect(withRaw.raw_text).toBe('something refused')
    const without = await logGuardrailEvent({
      layer: 'L1',
      category: 'sexual',
      text: 'something refused',
      retainRawText: false,
    })
    expect(without.raw_text).toBeNull()
    expect(without.input_hash).toBe(withRaw.input_hash)
  })

  it('writes through to the guardrail_events table via the Supabase sink', async () => {
    const rows: unknown[] = []
    setGuardrailSink(
      supabaseGuardrailSink({
        from: (table: string) => {
          expect(table).toBe('guardrail_events')
          return {
            insert: async (row: unknown) => {
              rows.push(row)
              return { error: null }
            },
          }
        },
      }),
    )
    await logGuardrailEvent({ layer: 'L2', category: 'horror_scary', text: 'scary thing' })
    expect(rows).toHaveLength(1)
  })

  it('surfaces a write failure rather than swallowing it', async () => {
    setGuardrailSink(
      supabaseGuardrailSink({
        from: () => ({ insert: async () => ({ error: { message: 'nope' } }) }),
      }),
    )
    await expect(
      logGuardrailEvent({ layer: 'L1', category: 'other', text: 'x' }),
    ).rejects.toThrow(/guardrail_events insert failed/)
  })
})

describe('s3.3 age-band enforcement is deterministic, not just advisory', () => {
  const base: InputClassification = {
    decision: 'allow_with_care',
    category: 'educational',
    care_notes: 'Focus on the engineering and the rescue.',
    min_recommended_age: 7,
    requested_characters: [],
    topic_key_hint: 'the-titanic',
    parent_message: null,
  }

  it('turns an allow_with_care into too_mature_for_band below the minimum age', () => {
    const at4 = applyAgeBand(base, 4)
    expect(at4.decision).toBe('refuse')
    expect(at4.category).toBe('too_mature_for_band')
  })

  it('leaves it as allow_with_care at or above the minimum age', () => {
    expect(applyAgeBand(base, 7).decision).toBe('allow_with_care')
    expect(applyAgeBand(base, 11).decision).toBe('allow_with_care')
  })

  it('keeps a self-contradictory too_mature answer as a refusal', () => {
    const contradictory: InputClassification = {
      ...base,
      decision: 'refuse',
      category: 'too_mature_for_band',
      min_recommended_age: 3,
      requested_characters: [],
    }
    const fixed = applyAgeBand(contradictory, 8)
    expect(fixed.decision).toBe('refuse')
    expect(fixed.min_recommended_age).toBeGreaterThan(8)
  })
})
