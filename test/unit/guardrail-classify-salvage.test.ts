import { describe, expect, it } from 'vitest'
import { applyAgeBand, salvageRefusal } from '@/lib/guardrails/classify'
import { echoesInput, isSafeParentMessage, parentMessageFor, refusalMessage } from '@/lib/guardrails/messages'

/**
 * VT-G1 (issue #24). The classifier declines a topic and, having no age to recommend, sends
 * `min_recommended_age: null`. That used to fail validation and flatten every specific
 * refusal into `other`. The reply below is the one production returned on 2026-10-02.
 */
const refusal = {
  decision: 'refuse',
  category: 'commercial_ip_character',
  care_notes: null,
  min_recommended_age: null,
  topic_key_hint: null,
  parent_message: 'We would love to tell the story of how comic books were invented instead.',
}

describe('salvageRefusal', () => {
  it('keeps a refusal whose only fault is a missing minimum age: decision, category and message intact', () => {
    const kept = salvageRefusal(refusal, 4)
    expect(kept).toMatchObject({
      decision: 'refuse',
      category: 'commercial_ip_character',
      parent_message: refusal.parent_message,
      min_recommended_age: 4,
    })
  })

  it('treats an absent age like a null one', () => {
    const { min_recommended_age: _dropped, ...withoutAge } = refusal
    expect(salvageRefusal(withoutAge, 7)?.category).toBe('commercial_ip_character')
  })

  it.each(['allow', 'allow_with_care'] as const)('never rescues an %s: that still fails closed', (decision) => {
    expect(salvageRefusal({ ...refusal, decision, category: 'educational' }, 4)).toBeNull()
  })

  it('does not rescue a refusal that is wrong in any other way', () => {
    expect(salvageRefusal({ ...refusal, category: 'not_a_category' }, 4)).toBeNull()
    expect(salvageRefusal({ ...refusal, parent_message: 12 }, 4)).toBeNull()
    expect(salvageRefusal({ ...refusal, decision: 'REFUSE' }, 4)).toBeNull()
  })

  it('leaves a reply that has an age alone - the normal path already handled it or rejected it', () => {
    expect(salvageRefusal({ ...refusal, min_recommended_age: 9 }, 4)).toBeNull()
    expect(salvageRefusal({ ...refusal, min_recommended_age: 'nine' }, 4)).toBeNull()
  })

  it.each([undefined, null, 'refuse', 42, [], [refusal]])('returns null for a reply that is not an object (%j)', (reply) => {
    expect(salvageRefusal(reply, 4)).toBeNull()
  })

  it('a kept refusal stays a refusal through the age-band step, whatever the age', () => {
    for (const age of [1, 4, 12, 18]) {
      const kept = salvageRefusal(refusal, age)!
      expect(applyAgeBand(kept, age).decision).toBe('refuse')
      expect(applyAgeBand(kept, age).category).toBe('commercial_ip_character')
    }
  })

  it('the parent now gets the message written for that reason, not the generic one', () => {
    const specific = refusalMessage({ category: 'commercial_ip_character', field: 'topic_input', internalReason: null })
    const generic = refusalMessage({ category: 'other', field: 'topic_input', internalReason: null })
    expect(specific).not.toBe(generic)
    expect(specific).toMatch(/real story behind them/i)
  })
})

/**
 * The gap issue #24 exposed: once refusals kept their own wording, a one-word topic could be
 * named straight back to the parent, because the echo rule only looked for four-word runs.
 */
describe('a short topic is never named back to the parent', () => {
  const production =
    "Spiderman is a branded character, so we can't tell that story—but we'd love to make a bedtime adventure about real spiders instead!"

  it('the message production returned on 2026-10-02 is caught', () => {
    expect(echoesInput(production, 'Spiderman')).toBe(true)
    expect(isSafeParentMessage(production, 'Spiderman')).toBe(false)
  })

  it('spacing, hyphens and capitals do not hide an echo', () => {
    expect(echoesInput('We can’t use Spider-Man, sorry.', 'spiderman')).toBe(true)
    expect(echoesInput('We can’t use spiderman, sorry.', 'Spider-Man')).toBe(true)
    expect(echoesInput('No PEPPA PIG tonight.', 'peppa pig')).toBe(true)
  })

  it('a short topic that is not repeated passes, so a kind tailored message still gets through', () => {
    const kind = 'How about real spiders, and how they build their webs?'
    expect(echoesInput(kind, 'Spiderman')).toBe(false)
    expect(isSafeParentMessage(kind, 'Spiderman')).toBe(true)
  })

  it('words under four letters do not count: "a", "the", "of" are everywhere', () => {
    expect(echoesInput('Try the story of how bees make honey.', 'the of a')).toBe(false)
  })

  it('longer inputs keep the four-word rule', () => {
    expect(echoesInput('We cannot write about how to pick a lock tonight.', 'a fun story about how to pick a lock')).toBe(true)
    expect(echoesInput('How about how bridges stay up?', 'a fun story about how to pick a lock')).toBe(false)
  })

  it('falls back to the pre-written message for that reason when the classifier echoes', () => {
    const shown = parentMessageFor(
      { decision: 'refuse', category: 'commercial_ip_character', care_notes: null, min_recommended_age: 4, topic_key_hint: null, parent_message: production },
      { rawInput: 'Spiderman', youngestAge: 4 },
    )
    expect(shown).not.toMatch(/spider/i)
    expect(shown).toMatch(/real story behind them/i)
  })
})
