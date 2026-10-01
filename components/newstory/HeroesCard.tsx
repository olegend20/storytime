'use client'

import Link from 'next/link'
import { useRef } from 'react'
import type { Child } from '@/lib/schemas'
import { joinNames } from '@/lib/client/reader'
import { ChildPicker } from './Pickers'

/**
 * "Tonight's heroes" (issue #17): the saved children by name, and a way to change them.
 *
 * The nightly form never asks for a name or an age again - they come from the profiles. The
 * selector is a native <dialog>: focus is held inside it and Escape closes it. Focus goes back
 * to the Change button when it closes.
 */
export function HeroesCard({
  options,
  selected,
  onToggle,
}: {
  /** null while the profiles are loading. */
  options: readonly Child[] | null
  selected: readonly string[]
  onToggle: (id: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  const chosen = (options ?? []).filter((c) => selected.includes(c.id))

  if (options === null) {
    return (
      <div className="st-heroes" aria-busy="true">
        <div>
          <span className="st-label-sm">Tonight’s heroes</span>
          <span className="st-heroes-names st-heroes-quiet">Loading your children…</span>
        </div>
      </div>
    )
  }

  if (options.length === 0) {
    return (
      <div className="st-heroes">
        <div>
          <span className="st-label-sm">Tonight’s heroes</span>
          <span className="st-heroes-names st-heroes-quiet">
            Add a child first and we’ll make them the hero of tonight’s story.
          </span>
        </div>
        <Link href="/children" className="st-textlink">
          Add a child
        </Link>
      </div>
    )
  }

  return (
    <div className="st-heroes">
      <div>
        <span className="st-label-sm">Tonight’s heroes</span>
        <span className="st-heroes-names" data-testid="heroes">
          {chosen.length > 0 ? joinNames(chosen.map((c) => c.first_name)) : 'Nobody yet'}
        </span>
      </div>
      <button
        type="button"
        ref={changeRef}
        className="st-textlink"
        onClick={() => dialogRef.current?.showModal()}
      >
        Change<span className="sr-only-text"> tonight’s heroes</span>
      </button>
      <dialog
        ref={dialogRef}
        className="st-dialog"
        aria-labelledby="heroes-title"
        // Safari does not focus a button when it is tapped, so the browser has nowhere to
        // return focus to; send it back to the control that opened the selector.
        onClose={() => changeRef.current?.focus()}
        // A click on the backdrop (the dialog element itself, outside its content) closes it.
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close()
        }}
      >
        <div className="st-dialog-in">
          <h2 id="heroes-title">Who’s in tonight’s story?</h2>
          <ChildPicker options={options} selected={selected} onToggle={onToggle} />
          <div className="st-dialog-actions">
            <Link href="/children" className="st-textlink">
              Add or manage children
            </Link>
            <button type="button" className="btn btn-quiet" onClick={() => dialogRef.current?.close()}>
              Done
            </button>
          </div>
        </div>
      </dialog>
    </div>
  )
}
