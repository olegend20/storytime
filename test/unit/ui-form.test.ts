import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TONES,
  MAX_TONES,
  TONE_LABELS,
  formBlocker,
  formToBody,
  initialFormState,
  toggleChild,
  toggleTone,
  type StoryFormState,
} from '@/lib/client/form'
import { DEFAULT_FORM_MEMORY } from '@/lib/client/storage'
import { GenerateStoryBody, Tone } from '@/lib/schemas'

const CHILD_A = '00000000-0000-4000-8000-00000000000a'
const CHILD_B = '00000000-0000-4000-8000-00000000000b'

function form(patch: Partial<StoryFormState> = {}): StoryFormState {
  return {
    childIds: [CHILD_A],
    topic: 'the history of LEGO',
    tones: ['funny'],
    lengthMinutes: 10,
    ...patch,
  }
}

describe('tone limit', () => {
  /**
   * MAX_TONES is a UI constant and `GenerateStoryBody.tones` is the contract. This test is the
   * thing that stops them drifting: if the lead widens the contract, the UI's limit fails here
   * rather than silently sending a body the server rejects.
   */
  it('agrees with GenerateStoryBody', () => {
    const base = { child_ids: [CHILD_A], topic_input: 'sharks', length_minutes: 10 as const }
    const atLimit = Tone.options.slice(0, MAX_TONES)
    const overLimit = Tone.options.slice(0, MAX_TONES + 1)
    expect(GenerateStoryBody.safeParse({ ...base, tones: atLimit }).success).toBe(true)
    expect(GenerateStoryBody.safeParse({ ...base, tones: overLimit }).success).toBe(false)
    expect(GenerateStoryBody.safeParse({ ...base, tones: [] }).success).toBe(false)
  })

  it('F10 AC: a third tone cannot be selected', () => {
    let state = form({ tones: [] })
    state = toggleTone(state, 'funny')
    state = toggleTone(state, 'exciting')
    const atLimit = state
    state = toggleTone(state, 'silly')
    expect(state.tones).toEqual(['funny', 'exciting'])
    // Refused, not swapped: the disabled chips a parent sees must match what state does.
    expect(state).toBe(atLimit)
  })

  it('deselecting frees a slot', () => {
    let state = form({ tones: ['funny', 'exciting'] })
    state = toggleTone(state, 'funny')
    expect(state.tones).toEqual(['exciting'])
    state = toggleTone(state, 'silly')
    expect(state.tones).toEqual(['exciting', 'silly'])
  })

  it('every tone in the enum has a parent-facing label', () => {
    for (const tone of Tone.options) {
      expect(TONE_LABELS[tone]).toBeTruthy()
    }
    // The plan writes this one as "calm/sleepy"; the enum value is `calm`.
    expect(TONE_LABELS.calm).toContain('sleepy')
  })
})

describe('defaults', () => {
  it('length defaults to 10 minutes (§0)', () => {
    expect(DEFAULT_FORM_MEMORY.lengthMinutes).toBe(10)
    expect(initialFormState(DEFAULT_FORM_MEMORY).lengthMinutes).toBe(10)
  })

  it('starts with two tones so a returning parent can type and go', () => {
    expect(DEFAULT_TONES).toHaveLength(2)
    expect(initialFormState(DEFAULT_FORM_MEMORY).tones).toEqual(DEFAULT_TONES)
  })

  it('restores remembered children and length', () => {
    const state = initialFormState({ childIds: [CHILD_A, CHILD_B], lengthMinutes: 15 })
    expect(state.childIds).toEqual([CHILD_A, CHILD_B])
    expect(state.lengthMinutes).toBe(15)
    expect(state.topic).toBe('')
  })
})

describe('toggleChild', () => {
  it('adds and removes', () => {
    let state = form({ childIds: [] })
    state = toggleChild(state, CHILD_A)
    state = toggleChild(state, CHILD_B)
    expect(state.childIds).toEqual([CHILD_A, CHILD_B])
    state = toggleChild(state, CHILD_A)
    expect(state.childIds).toEqual([CHILD_B])
  })
})

describe('formBlocker', () => {
  it('names what is missing', () => {
    expect(formBlocker(form())).toBeNull()
    expect(formBlocker(form({ childIds: [] }))).toBe('no_children')
    expect(formBlocker(form({ tones: [] }))).toBe('no_tone')
    expect(formBlocker(form({ topic: 'a' }))).toBe('topic')
    expect(formBlocker(form({ topic: '   ' }))).toBe('topic')
  })
})

describe('formToBody', () => {
  it('produces a body the contract accepts', () => {
    const body = formToBody(form())
    expect(body).not.toBeNull()
    expect(GenerateStoryBody.safeParse(body).success).toBe(true)
  })

  it('sends the sanitized topic, not the raw one', () => {
    const body = formToBody(form({ topic: '  <b>sharks</b>   and   whales  ' }))
    expect(body?.topic_input).toBe('sharks and whales')
  })

  it('refuses to build a body for an unsubmittable form', () => {
    expect(formToBody(form({ childIds: [] }))).toBeNull()
    expect(formToBody(form({ topic: '!!' }))).toBeNull()
    expect(formToBody(form({ tones: [] }))).toBeNull()
  })
})
