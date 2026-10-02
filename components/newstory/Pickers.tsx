'use client'

import { LengthMinutes, Tone, bandForAges, type Child } from '@/lib/schemas'
import { MAX_TONES, TONE_LABELS } from '@/lib/client/form'
import { Check } from '@/components/Icons'

/**
 * The three enum pickers on the nightly form (F10).
 *
 * All three are chip rows rather than selects: on a phone a native select is a full-screen modal
 * per field, which is three extra taps we are explicitly trying not to spend. A selected chip
 * carries a tick as well as a tint, so the state never rests on colour alone.
 */

export function ChildPicker({
  options,
  selected,
  onToggle,
}: {
  /** Named `options`, not `children`: a React prop called `children` means something else. */
  options: readonly Child[]
  selected: readonly string[]
  onToggle: (id: string) => void
}) {
  const chosen = options.filter((c) => selected.includes(c.id))
  // §4.5: vocabulary and peril follow the youngest selected child, so say which band that is.
  const band = chosen.length > 0 ? bandForAges(chosen.map((c) => c.age)) : null
  const youngest = chosen.length > 0 ? Math.min(...chosen.map((c) => c.age)) : null

  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="sr-only-text">Who&rsquo;s in tonight&rsquo;s story?</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((child) => {
          const isSelected = selected.includes(child.id)
          return (
            <button
              key={child.id}
              type="button"
              className="chip"
              aria-pressed={isSelected}
              onClick={() => onToggle(child.id)}
            >
              {isSelected ? <Check width={13} height={13} /> : null}
              <span>{child.first_name}</span>
              <span style={{ color: 'var(--fg-muted)', fontSize: '0.85em', fontWeight: 400 }}>{child.age}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 mb-0 text-sm" style={{ color: 'var(--fg-muted)' }} aria-live="polite">
        {chosen.length === 0
          ? 'Pick at least one.'
          : band && youngest !== null
            ? `Written for a ${youngest}-year-old (band ${band}) — the youngest sets the words and the peril.`
            : ''}
      </p>
    </fieldset>
  )
}

export function TonePicker({
  selected,
  onToggle,
}: {
  selected: readonly Tone[]
  onToggle: (tone: Tone) => void
}) {
  const full = selected.length >= MAX_TONES
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="st-legend">How should it feel?</legend>
      <div className="flex flex-wrap gap-2">
        {Tone.options.map((tone) => {
          const isSelected = selected.includes(tone)
          // Max 2 is enforced in state as well; disabling is what makes the limit legible.
          const disabled = !isSelected && full
          return (
            <button
              key={tone}
              type="button"
              className="chip"
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => onToggle(tone)}
            >
              {isSelected ? <Check width={13} height={13} /> : null}
              {TONE_LABELS[tone]}
            </button>
          )
        })}
      </div>
      <p className="mt-2 mb-0 text-sm" style={{ color: 'var(--fg-muted)' }} aria-live="polite">
        {full
          ? `That's the limit of ${MAX_TONES}. Tap one you've chosen to swap it.`
          : `Choose one or two feelings.`}
      </p>
    </fieldset>
  )
}

const LENGTHS: readonly LengthMinutes[] = [5, 10, 15]

export function LengthPicker({
  value,
  onChange,
}: {
  value: LengthMinutes
  onChange: (minutes: LengthMinutes) => void
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="st-legend">Time together</legend>
      <div role="radiogroup" aria-label="Story length in minutes" className="st-seg">
        {LENGTHS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            role="radio"
            aria-checked={value === minutes}
            className="st-seg-item"
            onClick={() => onChange(minutes)}
          >
            {minutes} min
          </button>
        ))}
      </div>
    </fieldset>
  )
}
