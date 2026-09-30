import { describe, expect, it } from 'vitest'
import { formBlocker, initialFormState, toggleChild } from '@/lib/client/form'
import { DEFAULT_FORM_MEMORY } from '@/lib/client/storage'
import { bandForAges } from '@/lib/schemas'

const MILO = 'c1'
const JUNO = 'c2'
const THEO = 'c3'
const ALL = [MILO, JUNO, THEO]

/**
 * The first-visit default.
 *
 * Found by a failing e2e test: with nothing remembered, an empty child selection left
 * "Start the story" disabled, which spends a tap on a decision the parent did not ask to make.
 * These cases pin the fix down so it cannot regress into either failure mode - no selection, or
 * overriding a parent who deliberately chose fewer children.
 */
describe('initialFormState', () => {
  it('selects every child on a first visit, so the form is submittable straight away', () => {
    const state = initialFormState(DEFAULT_FORM_MEMORY, ALL)
    expect(state.childIds).toEqual(ALL)
    expect(formBlocker(state)).not.toBe('no_children')
  })

  it('prefers the remembered selection over the family list', () => {
    const state = initialFormState({ childIds: [THEO], lengthMinutes: 10 }, ALL)
    expect(state.childIds).toEqual([THEO])
  })

  it('selects nothing when the children have not loaded yet', () => {
    expect(initialFormState(DEFAULT_FORM_MEMORY).childIds).toEqual([])
  })

  it('a parent can still deselect down to one child, and to none', () => {
    let state = initialFormState(DEFAULT_FORM_MEMORY, ALL)
    state = toggleChild(state, MILO)
    state = toggleChild(state, THEO)
    expect(state.childIds).toEqual([JUNO])
    state = toggleChild(state, JUNO)
    expect(state.childIds).toEqual([])
    expect(formBlocker(state)).toBe('no_children')
  })

  it('selecting everyone is the gentlest option, never the most mature (§4.5)', () => {
    // The youngest sets the band, so adding children can only lower it.
    const ages = [7, 4, 10]
    expect(bandForAges(ages)).toBe('A')
    expect(bandForAges([10])).toBe('C')
  })
})
