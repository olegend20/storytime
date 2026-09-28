'use client'

import { useEffect, useId, useState } from 'react'
import type { TrueFact } from '@/lib/schemas'
import { parseInline } from '@/lib/client/markdown'
import { loadCheckedFacts, saveCheckedFacts } from '@/lib/client/storage'

/**
 * F9: "True Facts section rendered as a checklist".
 *
 * Real checkboxes, one label each, so a screen reader announces "checkbox, checked, 3 of 8" and
 * a tap anywhere on the fact toggles it. State is per story in localStorage: the game a child
 * plays is ticking off the facts they remember, and that has to survive the reload when the
 * phone locks.
 */
export function TrueFactsChecklist({
  storyId,
  facts,
}: {
  storyId: string | null
  facts: readonly TrueFact[]
}) {
  const headingId = useId()
  const [checked, setChecked] = useState<number[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!storyId) {
      setLoaded(true)
      return
    }
    setChecked(loadCheckedFacts(storyId))
    setLoaded(true)
  }, [storyId])

  const toggle = (index: number) => {
    setChecked((current) => {
      const next = current.includes(index)
        ? current.filter((i) => i !== index)
        : [...current, index]
      if (storyId) saveCheckedFacts(storyId, next)
      return next
    })
  }

  const clear = () => {
    setChecked([])
    if (storyId) saveCheckedFacts(storyId, [])
  }

  if (facts.length === 0) return null

  return (
    <section aria-labelledby={headingId} className="card mt-10 p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="m-0 text-xl font-semibold">
          True facts from the story
        </h2>
        <p className="m-0 text-sm" style={{ color: 'var(--fg-muted)' }} aria-live="polite">
          {loaded ? `${checked.length} of ${facts.length} ticked` : `${facts.length} facts`}
        </p>
      </div>

      <ul className="mt-4 list-none space-y-1 p-0">
        {facts.map((fact, index) => {
          const isChecked = checked.includes(index)
          return (
            <li key={fact.fact_id + index}>
              <label
                className="flex cursor-pointer items-start gap-3 rounded-lg p-2"
                style={{ background: isChecked ? 'var(--accent-soft)' : 'transparent' }}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
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

      {checked.length > 0 && (
        <button type="button" className="btn btn-quiet mt-3" onClick={clear}>
          Clear ticks
        </button>
      )}
    </section>
  )
}
