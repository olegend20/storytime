'use client'

import { useCallback, useEffect, useRef } from 'react'

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
      if (target && target.closest('input, textarea, select, button, a, dialog, [contenteditable]')) {
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
      <div
        data-testid="chapters-bar"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line"
        style={{
          background: 'var(--bg-raised)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-2 py-2">
          <button
            type="button"
            className="btn btn-quiet tap tap-big"
            onClick={() => go(currentIndex - 1)}
            disabled={currentIndex <= 0}
            aria-label="Previous chapter"
            style={{ paddingInline: '0.75rem' }}
          >
            <span aria-hidden="true">←</span>
          </button>

          <button
            type="button"
            className="btn btn-quiet min-w-0 flex-1"
            onClick={open}
            aria-haspopup="dialog"
          >
            <span className="truncate">
              Chapter {currentIndex + 1} of {total}
            </span>
          </button>

          <button
            type="button"
            className="btn btn-quiet tap tap-big"
            onClick={() => go(currentIndex + 1)}
            disabled={currentIndex >= total - 1}
            aria-label="Next chapter"
            style={{ paddingInline: '0.75rem' }}
          >
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        aria-label="Chapters"
        className="card w-[min(28rem,92vw)] p-0"
        style={{ color: 'var(--fg)', background: 'var(--bg-raised)' }}
        onClick={(event) => {
          if (event.target === dialogRef.current) close()
        }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="m-0 text-lg font-semibold">Chapters</h2>
          <button type="button" className="btn btn-quiet" onClick={close}>
            Close
          </button>
        </div>
        <ol className="m-0 max-h-[60vh] list-none overflow-y-auto p-2">
          {headings.map((heading, index) => (
            <li key={index}>
              <button
                type="button"
                className="tap w-full rounded-lg px-3 py-3 text-left"
                aria-current={index === currentIndex ? 'true' : undefined}
                style={{
                  background: index === currentIndex ? 'var(--accent-soft)' : 'transparent',
                  fontWeight: index === currentIndex ? 650 : 450,
                  color: 'var(--fg)',
                }}
                onClick={() => {
                  close()
                  go(index)
                }}
              >
                {heading || `Chapter ${index + 1}`}
              </button>
            </li>
          ))}
        </ol>
      </dialog>
    </>
  )
}
