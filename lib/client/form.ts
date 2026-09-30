import { GenerateStoryBody, type LengthMinutes, type Tone } from '@/lib/schemas'
import { checkTopic } from './validate'

/**
 * The nightly form's state, as pure functions.
 *
 * Kept out of the components so the rules with ACs attached - max two tones, default length 10,
 * what counts as submittable - are unit-testable without a DOM.
 */

/**
 * §6 F10: "tones multi-select (... max 2)". The contract enforces it too
 * (`GenerateStoryBody.tones` is `.max(2)`), and a unit test asserts the two agree, so this
 * constant cannot drift away from the schema unnoticed.
 */
export const MAX_TONES = 2

/** The plan writes the calm tone as "calm/sleepy"; the enum value is `calm`. */
export const TONE_LABELS: Record<Tone, string> = {
  funny: 'funny',
  exciting: 'exciting',
  calm: 'calm & sleepy',
  mysterious: 'mysterious',
  silly: 'silly',
  'heart-warming': 'heart-warming',
}

export interface StoryFormState {
  childIds: string[]
  topic: string
  tones: Tone[]
  lengthMinutes: LengthMinutes
}

/**
 * Defaults chosen so a returning parent can tap the topic field and start typing:
 *  - length 10 (§0, the product default),
 *  - funny + exciting, the pairing all four reference stories were written with.
 * Children come from the remembered selection, so the common case is zero taps before typing.
 */
export const DEFAULT_TONES: Tone[] = ['funny', 'exciting']

export function initialFormState(
  remembered: { childIds: readonly string[]; lengthMinutes: LengthMinutes },
  /** Every child in the family, used only for the first-ever visit. */
  allChildIds: readonly string[] = [],
): StoryFormState {
  /**
   * On the first ever visit nothing is remembered, and an empty selection would leave "Start the
   * story" disabled with nothing on screen explaining why - a tap spent on something the parent
   * did not choose to think about. So the default is everyone.
   *
   * It is a safe default rather than a convenient one: §4.5 makes the YOUNGEST selected child set
   * the vocabulary and the peril, so including everybody can only make a story gentler, never
   * more mature than it should be. Deselecting is one tap.
   *
   * An empty remembered list always means "never submitted", because a submit requires at least
   * one child - so this can never override a parent who deliberately narrowed the selection.
   */
  const childIds = remembered.childIds.length > 0 ? [...remembered.childIds] : [...allChildIds]
  return {
    childIds,
    topic: '',
    tones: [...DEFAULT_TONES],
    lengthMinutes: remembered.lengthMinutes,
  }
}

export function toggleChild(state: StoryFormState, id: string): StoryFormState {
  return {
    ...state,
    childIds: state.childIds.includes(id)
      ? state.childIds.filter((c) => c !== id)
      : [...state.childIds, id],
  }
}

/**
 * Toggling a third tone is a no-op, not a silent replacement: the UI disables the other chips at
 * the limit, and state that quietly swapped one out would disagree with what the parent sees.
 */
export function toggleTone(state: StoryFormState, tone: Tone): StoryFormState {
  if (state.tones.includes(tone)) {
    return { ...state, tones: state.tones.filter((t) => t !== tone) }
  }
  if (state.tones.length >= MAX_TONES) return state
  return { ...state, tones: [...state.tones, tone] }
}

export type FormBlocker = 'no_children' | 'no_tone' | 'topic'

/** What is stopping submission, or null when nothing is. */
export function formBlocker(state: StoryFormState): FormBlocker | null {
  if (state.childIds.length === 0) return 'no_children'
  if (state.tones.length === 0) return 'no_tone'
  if (!checkTopic(state.topic).ok) return 'topic'
  return null
}

/**
 * Build the request body. Returns null when the form is not submittable, so a caller cannot
 * accidentally POST a half-filled form; the topic sent is the sanitized one.
 */
export function formToBody(state: StoryFormState): GenerateStoryBody | null {
  const topic = checkTopic(state.topic)
  if (!topic.ok) return null
  const candidate = {
    child_ids: state.childIds,
    topic_input: topic.value,
    tones: state.tones,
    length_minutes: state.lengthMinutes,
  }
  const parsed = GenerateStoryBody.safeParse(candidate)
  return parsed.success ? parsed.data : null
}
