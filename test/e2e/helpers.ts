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

/** Fill in the nightly form and submit it. Children and tones default, so this is topic-only. */
export async function startStory(page: Page, topic: string) {
  await page.getByLabel(/what.s the story about/i).fill(topic)
  await page.getByRole('button', { name: 'Start the story' }).click()
}
