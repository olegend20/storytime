'use client'

import { useCallback, useEffect, useState } from 'react'
import { Prose } from '@/components/reader/Prose'
import type { FactsEvent } from '@/lib/client/generate'

/**
 * "Did you know?" — what the children look at while the writer thinks.
 *
 * The story takes about two minutes to write, most of it the writer reasoning before the
 * first chapter, and a four-year-old will not sit through a spinner. The fact pack is ready
 * ~30 seconds in, so its facts - the very ones the story is about to use - are dealt as big
 * cards, one at a time, addressed to a child by name. No model call, no cost, no delay.
 *
 * Auto-advances every AUTO_ADVANCE_MS; a tap or → goes forward, ← back; loops. The whole
 * card is a button so it works on a phone held across the room. Reduced motion is honoured
 * by globals.css (every transition collapses to ~0).
 */

export const AUTO_ADVANCE_MS = 12_000

export interface FactCardsProps {
  facts: FactsEvent
  /** First names of the selected children; the cards take turns addressing them. */
  names: string[]
  /** Test seam: a shorter auto-advance. */
  autoAdvanceMs?: number
}

export function FactCards({ facts, names, autoAdvanceMs }: FactCardsProps) {
  const total = facts.facts.length
  const interval = autoAdvanceMs ?? testOverrideMs() ?? AUTO_ADVANCE_MS
  const [index, setIndex] = useState(0)
  const [turn, setTurn] = useState(0)

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => (i + delta + total) % total)
      setTurn((t) => t + 1)
    },
    [total],
  )

  useEffect(() => {
    if (total <= 1) return
    const timer = setInterval(() => go(1), interval)
    return () => clearInterval(timer)
    // Reset the interval whenever the card changes by hand, so a tap gives a full turn.
  }, [go, total, interval, turn])

  const fact = facts.facts[index]
  if (!fact) return null
  const name = names.length > 0 ? names[index % names.length] : null

  return (
    <section
      className="mx-auto max-w-2xl px-4 py-6"
      aria-labelledby="fact-cards-heading"
      data-testid="fact-cards"
    >
      <p className="mt-0 mb-3 text-sm" style={{ color: 'var(--fg-muted)' }}>
        Your story about <strong>{facts.topic_label}</strong> is being written. While you wait…
      </p>
      <button
        type="button"
        className="card block w-full cursor-pointer p-6 text-left sm:p-8"
        // A button's text is the browser's `buttontext` by default, which fails contrast on
        // the raised card in dark mode; the page's own foreground is what the reader uses.
        style={{ color: 'var(--fg)' }}
        onClick={() => go(1)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') go(1)
          if (e.key === 'ArrowLeft') go(-1)
        }}
        aria-label={`Fact ${index + 1} of ${total}. Tap for the next one.`}
        data-testid="fact-card"
      >
        <h2 id="fact-cards-heading" className="mt-0 mb-4 text-[clamp(1.4rem,4.5vw,2rem)]">
          {name ? `${name}, did you know?` : 'Did you know?'}
        </h2>
        <div
          key={fact.id}
          className="fact-card-body text-[clamp(1.25rem,4vw,1.75rem)] leading-snug"
          aria-live="polite"
        >
          <Prose text={fact.text} className="m-0" />
        </div>
      </button>
      <ol className="m-0 mt-4 flex list-none justify-center gap-2 p-0" aria-label="Which fact">
        {facts.facts.map((f, i) => (
          <li
            key={f.id}
            aria-current={i === index ? 'true' : undefined}
            className="h-2 w-2 rounded-full"
            style={{ background: i === index ? 'var(--accent)' : 'var(--fg-muted)', opacity: i === index ? 1 : 0.35 }}
          />
        ))}
      </ol>
      <p className="mt-3 mb-0 text-center text-sm" style={{ color: 'var(--fg-muted)' }}>
        Tap the card for the next one. Chapter 1 will appear here when it is ready.
      </p>
    </section>
  )
}

/** Before the facts arrive: the writer is getting ready. */
export function StoryWarmup({ names, onCancel }: { names: string[]; onCancel: () => void }) {
  const who = names.length > 0 ? joinNames(names) : 'Your story'
  return (
    <section className="mx-auto max-w-2xl px-4 py-6" data-testid="story-warmup" aria-live="polite">
      <div className="card p-6 sm:p-8">
        <h2 className="mt-0 mb-3 text-[clamp(1.4rem,4.5vw,2rem)]">
          {names.length > 0 ? `${who}, your story is on its way.` : `${who} is on its way.`}
        </h2>
        <p className="warmup-pulse m-0 text-lg" style={{ color: 'var(--fg-muted)' }}>
          Getting the facts ready…
        </p>
      </div>
      <button type="button" className="btn btn-quiet mt-4" onClick={onCancel}>
        Change the topic
      </button>
    </section>
  )
}

/** e2e only: `window.__FACT_CARD_MS` shortens the auto-advance so a test can watch it. */
function testOverrideMs(): number | null {
  if (typeof window === 'undefined') return null
  const v = (window as unknown as { __FACT_CARD_MS?: unknown }).__FACT_CARD_MS
  return typeof v === 'number' && v > 0 ? v : null
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
