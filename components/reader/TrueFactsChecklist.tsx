'use client'

import { useId } from 'react'
import type { TrueFact } from '@/lib/schemas'
import { parseInline } from '@/lib/client/markdown'
import { CheckedFacts, factsKey, saveCheckedFacts } from '@/lib/client/storage'
import { useStoredJson } from '@/lib/client/useStored'

/**
 * F9: "True Facts section rendered as a checklist".
 *
 * Real checkboxes, one label each, so a screen reader announces "checkbox, checked" and a tap
 * anywhere on the fact toggles it. The ticks are stored per story: the game a child plays is
 * ticking off the facts they remember, and that has to survive the phone locking mid-list.
 *
 * The ticked set lives only in localStorage - there is no component state - so the list, the
 * counter and the library card can never disagree about what is ticked.
 */
const NO_TICKS: number[] = []

export function TrueFactsChecklist({
  storyId,
  facts,
}: {
  storyId: string | null
  facts: readonly TrueFact[]
}) {
  const headingId = useId()
  // A streaming story has no id yet, so it gets a key nothing writes to.
  const key = factsKey(storyId ?? '__unsaved__')
  const checked = useStoredJson(key, CheckedFacts, NO_TICKS)

  const toggle = (index: number) => {
    if (!storyId) return
    const next = checked.includes(index)
      ? checked.filter((i) => i !== index)
      : [...checked, index]
    saveCheckedFacts(storyId, next)
  }

  if (facts.length === 0) return null

  return (
    <section aria-labelledby={headingId} className="card mt-10 p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="m-0 text-xl font-semibold">
          True facts from the story
        </h2>
        <p className="m-0 text-sm" style={{ color: 'var(--fg-muted)' }} aria-live="polite">
          {checked.length} of {facts.length} ticked
        </p>
      </div>

      <ul className="mt-4 list-none space-y-1 p-0">
        {facts.map((fact, index) => {
          const isChecked = checked.includes(index)
          return (
            <li key={`${fact.fact_id}-${index}`}>
              <label
                className="flex cursor-pointer items-start gap-3 rounded-lg p-2"
                style={{ background: isChecked ? 'var(--accent-soft)' : 'transparent' }}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={!storyId}
                  onChange={() => toggle(index)}
                  className="mt-1 shrink-0"
                  style={{ width: 22, height: 22, accentColor: 'var(--accent)' }}
                />
                <span className="prose" style={{ fontSize: 'calc(var(--prose-size) * 0.92)' }}>
                  {parseInline(fact.text).map((token, j) =>
                    token.kind === 'text' ? (
                      <span key={j}>{token.text}</span>
                    ) : token.kind === 'em' ? (
                      <em key={j}>{token.text}</em>
                    ) : (
                      <strong key={j}>{token.text}</strong>
                    ),
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      {storyId && checked.length > 0 && (
        <button
          type="button"
          className="btn btn-quiet mt-3"
          onClick={() => saveCheckedFacts(storyId, [])}
        >
          Clear ticks
        </button>
      )}
    </section>
  )
}
