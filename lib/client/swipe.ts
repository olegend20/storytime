/**
 * Swipe to turn the page (DECISIONS #147): a horizontal swipe on the story moves a chapter,
 * so a parent holding a phone one-handed in the dark never hunts for the button.
 *
 * Deliberately strict, because the same surface scrolls vertically: the swipe must be
 * mostly sideways, long enough to be meant, and quick enough not to be a scroll that
 * drifted. Pure, so the thresholds are pinned by tests.
 */
export interface Point {
  x: number
  y: number
  t: number
}

export const SWIPE_MIN_DISTANCE = 64
export const SWIPE_MAX_DRIFT = 48
export const SWIPE_MAX_MS = 700

export function swipeDirection(start: Point, end: Point): 'next' | 'prev' | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (end.t - start.t > SWIPE_MAX_MS) return null
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return null
  if (Math.abs(dy) > SWIPE_MAX_DRIFT || Math.abs(dy) > Math.abs(dx) * 0.6) return null
  // Swiping left (finger moves toward the left edge) turns to the next chapter, as in a book.
  return dx < 0 ? 'next' : 'prev'
}
