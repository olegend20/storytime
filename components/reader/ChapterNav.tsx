'use client'

import { useCallback, useEffect, useRef } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown } from '@/components/Icons'
import { Phase } from '@/components/Phase'

/**
 * F9: chapter navigation, and "chapter nav usable" on a 375x812 phone.
 *
 * A fixed bar at the bottom of the screen with three targets: back, a chapter picker, forward.
 * At the bottom because that is where a thumb is on a phone being held one-handed, and because
 * the top of the screen is where the story is.
 *
 * The picker is a native <dialog>: modal focus containment, Escape to close and correct screen
 * reader semantics come with it, and none of that is worth hand-rolling.
 */
/** A chapter as a moon: full once read, half while being read, new when still to come. */
function phaseFor(index: number, current: number): number {
  return index < current ? 1 : index === current ? 0.5 : 0
}

export function ChapterNav({
  headings,
  currentIndex,
  onGo,
}: {
  headings: readonly string[]
  currentIndex: number
  onGo: (index: number) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const total = headings.length

  const open = useCallback(() => dialogRef.current?.showModal(), [])
  const close = useCallback(() => dialogRef.current?.close(), [])

  const go = useCallback(
    (index: number) => {
      const clamped = Math.min(Math.max(index, 0), Math.max(total - 1, 0))
      onGo(clamped)
    },
    [onGo, total],
  )

  // Left/right arrows move between chapters when focus is not in a control or a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && target.closest('input, textarea, select, button, a, summary, details, dialog, [contenteditable]')) {
        return
      }
      if (event.key === 'ArrowRight') go(currentIndex + 1)
      else if (event.key === 'ArrowLeft') go(currentIndex - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentIndex, go])

  if (total === 0) return null

  return (
    <>
      <div data-testid="chapters-bar" className="st-cbar">
        <div className="st-cbar-in">
          <button
            type="button"
            className="st-rbtn st-cbar-arrow"
            onClick={() => go(currentIndex - 1)}
            disabled={currentIndex <= 0}
            aria-label="Previous chapter"
          >
            <ArrowLeft />
          </button>
          <button type="button" className="st-cpick" onClick={open} aria-haspopup="dialog">
            {/* Where you are in the book, as a row of moons: read, reading, still to come. */}
            <span className="st-phases" aria-hidden="true">
              {headings.map((_, index) => (
                <Phase key={index} lit={phaseFor(index, currentIndex)} size={12} />
              ))}
            </span>
            <span className="truncate">
              Chapter {currentIndex + 1} of {total}
            </span>
            <ChevronDown width={15} height={15} />
          </button>
          <button
            type="button"
            className="st-rbtn st-cbar-arrow"
            onClick={() => go(currentIndex + 1)}
            disabled={currentIndex >= total - 1}
            aria-label="Next chapter"
          >
            <ArrowRight />
          </button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        aria-label="Chapters"
        className="st-dialog st-dialog-chapters"
        onClick={(event) => {
          if (event.target === dialogRef.current) close()
        }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="m-0 text-xl font-normal">Chapters</h2>
          <button type="button" className="btn btn-quiet" onClick={close}>
            Close
          </button>
        </div>
        <ol className="m-0 max-h-[60vh] list-none overflow-y-auto p-2">
          {headings.map((heading, index) => (
            <li key={index}>
              <button
                type="button"
                className="st-chapter-item"
                aria-current={index === currentIndex ? 'true' : undefined}
                onClick={() => {
                  close()
                  go(index)
                }}
              >
                <Phase lit={phaseFor(index, currentIndex)} size={13} />
                <span>{heading || `Chapter ${index + 1}`}</span>
              </button>
            </li>
          ))}
        </ol>
      </dialog>
    </>
  )
}
