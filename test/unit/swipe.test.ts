import { describe, expect, it } from 'vitest'
import { swipeDirection } from '@/lib/client/swipe'

/** Swipe to turn the page (DECISIONS #147): sideways and deliberate, never a drifting scroll. */
const at = (x: number, y: number, t = 0) => ({ x, y, t })

describe('swipeDirection', () => {
  it('a leftward swipe is next, a rightward swipe is previous', () => {
    expect(swipeDirection(at(300, 400), at(200, 405, 200))).toBe('next')
    expect(swipeDirection(at(100, 400), at(220, 390, 200))).toBe('prev')
  })
  it('ignores a short flick, a vertical scroll, and a slow drag', () => {
    expect(swipeDirection(at(300, 400), at(260, 400, 100))).toBeNull()
    expect(swipeDirection(at(300, 400), at(220, 480, 200))).toBeNull()
    expect(swipeDirection(at(300, 400), at(300, 200, 200))).toBeNull()
    expect(swipeDirection(at(300, 400), at(150, 400, 1500))).toBeNull()
  })
})
