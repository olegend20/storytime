'use client'

import { useEffect, useRef, type ReactNode } from 'react'

/**
 * A small popover menu behind an icon (issue #17): the reader's theme choices and its story
 * actions. A native <details>, so it opens and closes from the keyboard with no script;
 * the script only adds what a popover is expected to do - close on Escape (focus back on the
 * button) and on a tap anywhere else.
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !details.open) return
      details.open = false
      details.querySelector('summary')?.focus()
    }
    const onPointer = (event: PointerEvent) => {
      if (details.open && !details.contains(event.target as Node)) details.open = false
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
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
