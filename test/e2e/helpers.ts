import type { Page } from '@playwright/test'

/**
 * Shared e2e plumbing for the lane 4 specs.
 *
 * `/api/mock/debug` is the mock backend's control surface. It is what lets these tests ASSERT
 * F9's "zero model calls" and F10's exhausted-quota state instead of assuming them. Mock state is
 * keyed by a cookie, so each Playwright browser context has its own quota and library and the
 * suite can run fully parallel.
 */

export interface MockState {
  sid: string
  model_calls: number
  quota_used: number
  quota_limit: number
  generation_enabled: boolean
  story_ids: string[]
}

export async function mockState(page: Page): Promise<MockState> {
  const res = await page.request.get('/api/mock/debug')
  if (!res.ok()) throw new Error(`mock debug returned ${res.status()} - is UI_MOCK_API=1 set?`)
  return (await res.json()) as MockState
}

export async function patchMock(page: Page, patch: Partial<MockState & { reset: boolean }>) {
  const res = await page.request.post('/api/mock/debug', { data: patch })
  if (!res.ok()) throw new Error(`mock debug patch returned ${res.status()}`)
  return (await res.json()) as MockState
}

/** Reset to a known state: one story used of three, nothing generated. */
export async function resetMock(page: Page) {
  return patchMock(page, { reset: true, quota_used: 1, model_calls: 0 })
}

/** Nothing on the page may be wider than the viewport (F9 AC: 375px, no horizontal scroll). */
export async function horizontalOverflow(page: Page): Promise<{
  documentOverflows: boolean
  widest: { tag: string; text: string; width: number } | null
}> {
  return page.evaluate(() => {
    const viewport = window.innerWidth
    const documentOverflows = document.documentElement.scrollWidth > viewport + 1
    let widest: { tag: string; text: string; width: number } | null = null
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      // A fixed element positioned off-screen on purpose (the skip link) is not overflow.
      if (style.position === 'fixed' && parseFloat(style.top) < 0) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0) continue
      const right = rect.left + rect.width
      const overflowBy = Math.max(right - viewport, -rect.left)
      if (overflowBy > 1 && (!widest || rect.width > widest.width)) {
        widest = {
          tag: element.tagName.toLowerCase() + (element.className ? `.${String(element.className).slice(0, 40)}` : ''),
          text: (element.textContent ?? '').trim().slice(0, 60),
          width: Math.round(rect.width),
        }
      }
    }
    return { documentOverflows, widest }
  })
}

/**
 * The body's background as sRGB bytes.
 *
 * `getComputedStyle().backgroundColor` now serializes in the author's colour space, so an `oklch()`
 * token comes back as `oklch(...)` and cannot be parsed as `rgb()`. Painting it into a 1x1 canvas
 * resolves any colour syntax to actual pixels.
 */
export async function bodyBackgroundRgb(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const color = getComputedStyle(document.body).backgroundColor
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const data = ctx.getImageData(0, 0, 1, 1).data
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0] as [number, number, number]
  })
}

export function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Scroll, then wait for the reader's debounced save to land.
 *
 * `mouse.wheel` is not supported in mobile WebKit, so the scroll is programmatic, and the wait is
 * on the stored value rather than on a timer.
 */
export async function scrollToAndPersist(page: Page, y: number): Promise<number> {
  await page.evaluate((top) => window.scrollTo(0, top), y)
  const settled = await page.evaluate(() => window.scrollY)
  await page.waitForFunction(
    (expected) => {
      const key = Object.keys(localStorage).find((k) => k.includes(':scroll:'))
      if (!key) return false
      const raw = localStorage.getItem(key)
      if (!raw) return false
      const stored = Number((JSON.parse(raw) as { y?: unknown }).y)
      return Number.isFinite(stored) && Math.abs(stored - expected) < 50
    },
    Math.round(settled),
    { timeout: 10_000 },
  )
  return settled
}

/** Fill in the nightly form and submit it. Children and tones default, so this is topic-only. */
export async function startStory(page: Page, topic: string) {
  await page.getByLabel(/what.s the story about/i).fill(topic)
  await page.getByRole('button', { name: 'Start the story' }).click()
}
