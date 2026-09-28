'use client'

import { useEffect, useRef } from 'react'
import { detectTimeZone } from '@/lib/family/timezone'

/**
 * F2: "timezone (auto-detected, editable)".
 *
 * A family created by opening a magic link in a different browser than the one that
 * requested it has no `st_tz` cookie to read, so it starts on the schema default of UTC.
 * This fills that in once, silently, the first time the parent reaches the dashboard.
 *
 * `timezone === 'UTC'` is the "never set" signal. There is deliberately no extra column
 * for it: the only cost of the ambiguity is that a family genuinely in UTC gets written
 * back to UTC, which changes nothing. A family that has chosen a zone in Settings is never
 * touched.
 */
export default function TimezoneSync({ current }: { current: string }) {
  const done = useRef(false)

  useEffect(() => {
    if (done.current) return
    if (current !== 'UTC') return
    const detected = detectTimeZone()
    if (detected === 'UTC') return
    done.current = true
    void fetch('/api/family', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timezone: detected }),
    }).catch(() => {
      /* best effort: the parent can always set it in Settings */
    })
  }, [current])

  return null
}
