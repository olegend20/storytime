'use client'

import { LengthMinutes, Tone, bandForAges, type Child } from '@/lib/schemas'
import { MAX_TONES, TONE_LABELS } from '@/lib/client/form'

/**
 * The three enum pickers on the nightly form (F10).
 *
 * All three are chip rows rather than selects: on a phone a native select is a full-screen modal
 * per field, which is three extra taps we are explicitly trying not to spend.
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
      <legend className="mb-2 p-0 text-base font-semibold">Who&rsquo;s in tonight&rsquo;s story?</legend>
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
              <span>{child.first_name}</span>
              <span style={{ opacity: 0.75, fontSize: '0.85em' }}>{child.age}</span>
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
      <legend className="mb-2 p-0 text-base font-semibold">
        How should it feel? <span style={{ fontWeight: 400 }}>(up to {MAX_TONES})</span>
      </legend>
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
              {TONE_LABELS[tone]}
            </button>
          )
        })}
      </div>
      <p className="mt-2 mb-0 text-sm" style={{ color: 'var(--fg-muted)' }} aria-live="polite">
        {full
          ? `That's the limit of ${MAX_TONES}. Tap one you've chosen to swap it.`
          : `Choose one or two.`}
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
      <legend className="mb-2 p-0 text-base font-semibold">How long?</legend>
      <div role="radiogroup" aria-label="Story length in minutes" className="flex flex-wrap gap-2">
        {LENGTHS.map((minutes) => (
          <button
            key={minutes}
            type="button"
            role="radio"
            aria-checked={value === minutes}
            className="chip"
            onClick={() => onChange(minutes)}
          >
            {minutes} min{minutes === 10 ? ' · usual' : ''}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
