import { describe, expect, it } from 'vitest'
import {
  borrowsCharacter,
  classifierPromptVersion,
  classifierSystemPrompt,
  confirmCharacters,
  MAKE_BELIEVE_WRITER_RULES,
  withMakeBelieveRules,
} from '@/lib/guardrails/classify'
import { isMakeBelieveKind, mentionsMakeBelieveKind, namedInTopic } from '@/lib/guardrails/names'
import { loadPrompt } from '@/lib/prompts'
import type { InputClassification } from '@/lib/schemas/guardrail'

/**
 * Issue #130: a make-believe creature (a mermaid, a unicorn, a dragon) was refused as
 * off_mission. These pin the prompt's side of the fix without a model call; the classifier's
 * actual decisions are measured by the corpus (VT-MB1, VT-MB2 in test/guardrails).
 */
describe('make-believe creatures (issue #130)', () => {
  const prompt = classifierSystemPrompt()

  it('the live classifier prompt is v3', () => {
    expect(classifierPromptVersion()).toBe(3)
  })

  it('allows a make-believe creature as an educational topic with care', () => {
    expect(prompt).toContain('**A make-believe creature**')
    expect(prompt).toMatch(/A make-believe creature on its own never makes a request out of scope/)
    expect(prompt).toMatch(/a make-believe creature included,\s+except a requested character/)
  })

  it('never returns a plain allow for a creature: the care notes are how the writer hears of it', () => {
    expect(prompt).toMatch(/never return a plain `allow` here/)
  })

  it('the rules about real-or-not are code\'s fixed wording, not the classifier\'s', () => {
    expect(prompt).toMatch(/Do not write anything about\s+whether the creature is real/)
    expect(MAKE_BELIEVE_WRITER_RULES).toMatch(/stays out of the True Facts list/)
    expect(MAKE_BELIEVE_WRITER_RULES).toMatch(/says that the creature is real or that it is not/)
  })

  it('adds the fixed rules when the parent typed a creature and the notes are about one', () => {
    const reply: InputClassification = {
      decision: 'allow_with_care',
      category: 'educational',
      care_notes: 'Teach how deep-sea animals glow. Make clear in True Facts that mermaids are make-believe.',
      min_recommended_age: 4,
      requested_characters: [],
      topic_key_hint: 'deep-sea-animals',
      parent_message: null,
    }
    const out = confirmCharacters(reply, 'How do mermaids find their way in the dark?')
    expect(out.care_notes?.startsWith('Teach how deep-sea animals glow.')).toBe(true)
    expect(out.care_notes?.endsWith(MAKE_BELIEVE_WRITER_RULES)).toBe(true)

    // The classifier's notes are cut to fit the schema's 800 characters, never the rules.
    const long = withMakeBelieveRules({ ...reply, care_notes: `The mermaid guides. ${'x'.repeat(790)}` }, 'a mermaid story')
    expect(long.care_notes!.length).toBeLessThanOrEqual(800)
    expect(long.care_notes!.endsWith(MAKE_BELIEVE_WRITER_RULES)).toBe(true)
  })

  it('adds nothing when the word alone is there: a giant squid is not a giant', () => {
    const squid: InputClassification = {
      decision: 'allow_with_care',
      category: 'educational',
      care_notes: 'Keep the deep sea wondrous, not frightening.',
      min_recommended_age: 4,
      requested_characters: [],
      topic_key_hint: 'giant-squid',
      parent_message: null,
    }
    expect(mentionsMakeBelieveKind('a giant squid')).toBe(true)
    expect(confirmCharacters(squid, 'a giant squid').care_notes).toBe(squid.care_notes)
    // Nor for a plain allow, a refusal, or a topic with no creature in it.
    expect(withMakeBelieveRules({ ...squid, decision: 'allow', care_notes: null }, 'a mermaid story').care_notes).toBeNull()
    expect(confirmCharacters({ ...squid, care_notes: 'A dragon legend comes up.' }, 'the history of kites').care_notes).toBe(
      'A dragon legend comes up.',
    )
    expect(mentionsMakeBelieveKind('the tooth fairy')).toBe(true)
    expect(mentionsMakeBelieveKind('dragonflies and fairy-tale castles')).toBe(true)
    expect(mentionsMakeBelieveKind('how sharks sleep')).toBe(false)
  })

  it('opens no other door: a frightening creature is still horror_scary', () => {
    expect(prompt).toMatch(/This does not open any other door either/)
    expect(prompt).toMatch(/a monster that hunts children\) is\s+`horror_scary`/)
  })

  it('a creature is not a character: no name is handed on, so no borrowed-character notice', () => {
    const reply: InputClassification = {
      decision: 'allow_with_care',
      category: 'educational',
      care_notes: 'Teach how deep-sea animals glow; the mermaid comes along as a companion.',
      min_recommended_age: 4,
      requested_characters: [],
      topic_key_hint: 'deep-sea-animals',
      parent_message: null,
    }
    const confirmed = confirmCharacters(reply, 'How do mermaids find their way in the dark?')
    expect(confirmed.category).toBe('educational')
    expect(confirmed.requested_characters).toEqual([])
    expect(confirmed.care_notes).toBe(`${reply.care_notes}\n${MAKE_BELIEVE_WRITER_RULES}`)
  })

  it('code never treats a kind of creature as a character, even when the model lists one', () => {
    const reply: InputClassification = {
      decision: 'allow_with_care',
      category: 'commercial_ip_character',
      care_notes: 'Teach how teeth grow; the tooth fairy comes along as a pretend companion.',
      min_recommended_age: 4,
      requested_characters: ['Tooth Fairy'],
      topic_key_hint: 'how-teeth-grow',
      parent_message: null,
    }
    const confirmed = confirmCharacters(reply, 'the tooth fairy')
    expect(confirmed.requested_characters).toEqual([])
    expect(confirmed.category).toBe('educational')
    expect(confirmed.care_notes).toBe(`${reply.care_notes}\n${MAKE_BELIEVE_WRITER_RULES}`)
    expect(borrowsCharacter(confirmed)).toBe(false)
  })

  it('knows the kinds of creature, and leaves named characters alone', () => {
    for (const kind of ['Mermaid', 'mermaids', 'the Tooth Fairy', 'Unicorn', 'dragons', 'Elves']) {
      expect(isMakeBelieveKind(kind), kind).toBe(true)
    }
    for (const name of ['Ariel', 'Toothless', 'Elsa', 'Sonic']) {
      expect(isMakeBelieveKind(name), name).toBe(false)
    }
    expect(namedInTopic(['Mermaid'], 'a mermaid story')).toEqual([])
    expect(namedInTopic(['Elsa'], 'Elsa and a mermaid')).toEqual(['Elsa'])
  })

  it('the topic normalizer keys a creature on its real subject (normalize v3)', () => {
    const normalize = loadPrompt('normalize')
    expect(normalize.version).toBe(3)
    expect(normalize.body).toContain('**A make-believe creature is not the subject either.**')
    expect(normalize.body).toContain('| How do mermaids find their way in the dark? | deep-sea-animals |')
  })
})
