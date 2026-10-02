'use client'

import { useEffect, useRef, type ReactNode } from 'react'

/**
 * A small popover menu behind an icon (issue #17): the reader's theme choices and its story
 * actions. A native <details>, so it opens and closes from the keyboard with no script; the
 * script adds what a popover is expected to do - close on Escape (focus back on its button),
 * on a tap anywhere else, and when focus moves out of it - and makes sure only one menu is
 * open at a time. Four cheap listeners per menu, and a reader has two menus.
 */
export function Menu({
  label,
  icon,
  children,
  testId,
}: {
  /** What the button does, for a screen reader: the icon alone says nothing. */
  label: string
  icon: ReactNode
  children: ReactNode
  testId?: string
}) {
  const ref = useRef<HTMLDetailsElement>(null)

  useEffect(() => {
    const details = ref.current
    if (!details) return
    const summary = details.querySelector('summary')

    // One menu at a time. Done on the click that opens this one - which a key press on the
    // button also fires - and not on the `toggle` event: that event is delivered later, and
    // two menus opened in quick succession would each close the other.
    const onSummaryClick = () => {
      if (details.open) return
      for (const other of document.querySelectorAll<HTMLDetailsElement>('details.st-menu[open]')) {
        if (other !== details) other.open = false
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !details.open) return
      details.open = false
      summary?.focus()
    }
    const onPointer = (event: PointerEvent) => {
      if (details.open && !details.contains(event.target as Node)) details.open = false
    }
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null
      if (details.open && next && !details.contains(next)) details.open = false
    }
    summary?.addEventListener('click', onSummaryClick)
    details.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      summary?.removeEventListener('click', onSummaryClick)
      details.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [])

  return (
    <details ref={ref} className="st-menu" data-testid={testId}>
      <summary className="st-iconbtn" aria-label={label} title={label}>
        {icon}
      </summary>
      <div className="st-menu-panel">{children}</div>
    </details>
  )
}
