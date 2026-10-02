import { describe, expect, it } from 'vitest'
import { applyAgeBand, salvageRefusal } from '@/lib/guardrails/classify'
import { isSafeParentMessage, parentMessageFor, refusalMessage } from '@/lib/guardrails/messages'

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

  it.each([0, 21, 99, -3, 4.5, 'N/A', 'nine', false])('overwrites an unusable age on a refusal (%j): it means nothing there', (age) => {
    const kept = salvageRefusal({ ...refusal, min_recommended_age: age }, 6)
    expect(kept).toMatchObject({ decision: 'refuse', category: 'commercial_ip_character', min_recommended_age: 6 })
  })

  it('leaves a reply with a usable age alone: the age was not what failed, so it still fails closed', () => {
    expect(salvageRefusal({ ...refusal, min_recommended_age: 9 }, 4)).toBeNull()
  })

  it('does not keep a refusal that contradicts itself (refuse + the allow category)', () => {
    expect(salvageRefusal({ ...refusal, category: 'educational' }, 4)).toBeNull()
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
 * What issue #24 exposed next: once a refusal kept its own wording, that wording named the
 * topic straight back ("X is a branded character..."). No after-the-fact check catches that
 * for every input, so a refusal never shows the classifier's wording at all.
 */
describe('what the parent is shown', () => {
  const production =
    "Spiderman is a branded character, so we can't tell that story—but we'd love to make a bedtime adventure about real spiders instead!"
  const refusalWith = (message: string | null, category = 'commercial_ip_character' as const) => ({
    decision: 'refuse' as const,
    category,
    care_notes: null,
    min_recommended_age: 4,
    topic_key_hint: null,
    parent_message: message,
  })

  it('a refusal shows the pre-written message for its reason, never the classifier wording', () => {
    const shown = parentMessageFor(refusalWith(production), { rawInput: 'Spiderman', youngestAge: 4 })
    expect(shown).toBe(refusalMessage({ category: 'commercial_ip_character', youngestAge: 4 }))
    expect(shown).not.toMatch(/spider/i)
  })

  // Each of these slipped past a word-matching echo check in review; none can now, because
  // the classifier's wording is not used for a refusal whatever it says.
  it.each([
    ['a four-word topic', 'a story about Spiderman', 'Spiderman is a branded character, so no.'],
    ['an accent the parent did not type', 'Pokemon', 'Pokémon is a branded game, so no.'],
    ['a two-letter title', 'Up', 'Up is a film, so we cannot use it.'],
    ['a hyphen the parent did not type', 'spiderman', 'We cannot use Spider-Man tonight.'],
  ])('%s is not named back', (_what, input, modelMessage) => {
    const shown = parentMessageFor(refusalWith(modelMessage), { rawInput: input, youngestAge: 6 })
    expect(shown).toBe(refusalMessage({ category: 'commercial_ip_character', youngestAge: 6 }))
  })

  it('a refusal triggered by a like or a note cannot leak it either: the topic is not what is checked, nothing is', () => {
    const shown = parentMessageFor(refusalWith('Fortnite is a branded game, so the profile needs a quick edit.'), {
      rawInput: 'volcanoes',
      youngestAge: 8,
    })
    expect(shown).not.toMatch(/fortnite/i)
  })

  it('every refusal category gets its own template, and none of them is the classifier wording', () => {
    for (const category of ['off_mission', 'real_private_person', 'horror_scary', 'weapons_instructions', 'other'] as const) {
      const shown = parentMessageFor(refusalWith('MODEL WROTE THIS', category as never), { rawInput: 'anything', youngestAge: 5 })
      expect(shown, category).toBe(refusalMessage({ category, youngestAge: 5 }))
      expect(shown, category).not.toContain('MODEL WROTE THIS')
    }
  })

  it('too mature for this age is the exception: a gentler angle on a legitimate subject is still offered', () => {
    const gentler = "That one's a bit much for a 4-year-old. How about how giant ships float?"
    const shown = parentMessageFor(
      { ...refusalWith(gentler), category: 'too_mature_for_band', min_recommended_age: 7 },
      { rawInput: 'the Titanic disaster and everyone who drowned', youngestAge: 4 },
    )
    expect(shown).toBe(gentler)
  })

  it('and even there, a message that fails the checks falls back to the template', () => {
    const leaky = 'Our classifier flagged that one.'
    const shown = parentMessageFor(
      { ...refusalWith(leaky), category: 'too_mature_for_band', min_recommended_age: 7 },
      { rawInput: 'the Titanic', youngestAge: 4 },
    )
    expect(shown).not.toBe(leaky)
    expect(isSafeParentMessage(leaky, 'the Titanic')).toBe(false)
  })
})
