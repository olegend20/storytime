import { describe, expect, it } from 'vitest'
import { classifierPromptVersion, classifierSystemPrompt, confirmCharacters } from '@/lib/guardrails/classify'
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

  it('tells the writer never to say whether the creature is real', () => {
    expect(prompt).toMatch(/must never state that the\s+creature is real or that it is not/)
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
    expect(confirmed.care_notes).toBe(reply.care_notes)
  })
})
