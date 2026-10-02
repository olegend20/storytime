'use client'

import { useId } from 'react'
import { TOPIC_MAX_LENGTH } from '@/lib/client/validate'
import type { SuggestedTopic } from '@/lib/client/topics'

/**
 * The topic input and its suggested chips (F10; three at a time since the calm design, #17).
 *
 * The chips carry most of the weight in practice: they are how a parent who has no idea
 * tonight still gets to a story in one tap, and "More ideas" turns the row over. `warm` chips
 * are marked because a fact pack already exists for them, so that story starts writing
 * sooner - and telling the parent which those are is more honest than a uniform row.
 */
export function TopicField({
  value,
  onChange,
  chips,
  onShuffle,
  message,
  inputRef,
}: {
  value: string
  onChange: (value: string) => void
  chips: readonly SuggestedTopic[]
  onShuffle: () => void
  /** Inline validation message from the client mirror; null when the topic looks fine. */
  message: string | null
  inputRef?: React.Ref<HTMLInputElement>
}) {
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()

  return (
    <div>
      <label htmlFor={inputId} className="st-label">
        What shall we discover tonight?
      </label>
      <input
        id={inputId}
        ref={inputRef}
        className="field st-topic"
        type="text"
        value={value}
        maxLength={TOPIC_MAX_LENGTH}
        autoComplete="off"
        enterKeyHint="go"
        placeholder="How the Moon shines…"
        aria-describedby={message ? `${hintId} ${errorId}` : hintId}
        aria-invalid={message ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={hintId} className="sr-only-text">
        Anything they want to learn about. True facts come at the end.
      </p>
      {message && (
        <p id={errorId} className="mt-2 mb-0 text-sm" role="alert" style={{ color: 'var(--danger)' }}>
          {message}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <h3 className="sr-only-text" id="suggested-heading">
          Or pick an idea
        </h3>
        <ul aria-labelledby="suggested-heading" className="m-0 flex list-none flex-wrap gap-2 p-0">
          {chips.map((chip) => (
            <li key={chip.topic_key}>
              <button
                type="button"
                className="chip"
                aria-pressed={value === chip.label}
                onClick={() => onChange(chip.label)}
              >
                {chip.label}
                {chip.warm && (
                  <>
                    <span
                      aria-hidden="true"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        // currentColor so the dot stays visible once the chip is selected and
                        // its background becomes the accent.
                        background: 'currentColor',
                        opacity: 0.75,
                        display: 'inline-block',
                      }}
                    />
                    <span className="sr-only-text">starts straight away</span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="st-textlink" onClick={onShuffle}>
          More ideas
        </button>
      </div>
    </div>
  )
}
