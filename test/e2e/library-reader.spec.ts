import { expect, test, type Page } from '@playwright/test'
import {
  bodyBackgroundRgb,
  horizontalOverflow,
  mockState,
  relativeLuminance,
  resetMock,
  scrollToAndPersist,
  startStory,
} from './helpers'

/**
 * F9 — story library and reader. Each test maps to a VT in §6 F9.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/library')
  await resetMock(page)
  await page.reload()
})

async function openFirstStory(page: Page) {
  const card = page.getByRole('link', { name: /read/i }).first()
  await card.click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'True facts from the story' })).toBeVisible()
}

/**
 * VT: generate one story (fixture mode), navigate to library, open it, confirm all chapters and
 * the facts list render; `generation_logs` count unchanged by the open.
 *
 * `model_calls` on the mock backend is the stand-in for the `generation_logs` count.
 */
test('generate, open from the library, and the open costs zero model calls', async ({ page }) => {
  await page.goto('/new')
  await expect(page.getByRole('button', { name: 'Cruz 7' })).toBeVisible()
  await startStory(page, 'the history of soccer')
  await expect(page.getByRole('heading', { name: 'Saved to your library' })).toBeVisible({
    timeout: 30_000,
  })
  const title = (await page.getByRole('heading', { level: 1 }).innerText()).trim()
  const chapterCount = await page.getByRole('heading', { level: 2 }).count()
  const afterGenerate = await mockState(page)
  expect(afterGenerate.model_calls).toBe(1)

  await page.getByRole('link', { name: 'Library' }).first().click()
  await expect(page.getByRole('heading', { name: 'Story library' })).toBeVisible()
  const card = page.getByRole('link').filter({ hasText: title })
  await expect(card).toBeVisible()

  await card.click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()

  // Every chapter and the whole facts list are on the page.
  await expect(page.getByRole('heading', { name: 'True facts from the story' })).toBeVisible()
  const facts = page.getByRole('checkbox')
  expect(await facts.count()).toBeGreaterThanOrEqual(8)
  const headings = await page.getByRole('heading', { level: 2 }).count()
  // Same chapter headings as the streamed version, plus the facts and footer headings.
  expect(headings).toBeGreaterThanOrEqual(chapterCount)
  // Exact: chapter prose legitimately contains the phrase "in the end".
  await expect(page.getByText('The End', { exact: true })).toBeVisible()

  // The open, and re-reading it, made no model calls at all.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  const afterOpen = await mockState(page)
  expect(afterOpen.model_calls).toBe(afterGenerate.model_calls)
})

test('the library groups stories by series, newest first', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Story library' })).toBeVisible()
  // The fixture family has two series.
  await expect(page.getByRole('heading', { name: 'Cruz & Phoenix' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Lennon', exact: true })).toBeVisible()

  const seriesSections = page.locator('section[aria-labelledby^="series-"]')
  await expect(seriesSections).toHaveCount(2)
  await expect(seriesSections.first().getByText(/2 stories in this series/)).toBeVisible()
})

/** VT (mobile viewport 375x812): no element wider than viewport; chapter nav usable. */
test('the reader has no horizontal overflow and its chapter nav works', async ({ page }) => {
  await openFirstStory(page)

  const overflow = await horizontalOverflow(page)
  expect(
    overflow.widest,
    `element overflows the viewport: ${JSON.stringify(overflow.widest)}`,
  ).toBeNull()
  expect(overflow.documentOverflows).toBe(false)

  // The nav bar: previous is disabled at chapter 1, next advances, and the picker lists them all.
  const picker = page.getByRole('button', { name: /^Chapter \d+ of \d+$/ })
  await expect(picker).toBeVisible()
  await expect(page.getByRole('button', { name: 'Previous chapter' })).toBeDisabled()

  await page.getByRole('button', { name: 'Next chapter' }).click()
  await expect(picker).toHaveText(/Chapter 2 of \d+/)
  await expect(page.getByRole('button', { name: 'Previous chapter' })).toBeEnabled()

  await picker.click()
  const dialog = page.getByRole('dialog', { name: 'Chapters' })
  await expect(dialog).toBeVisible()
  const items = dialog.getByRole('button').filter({ hasNotText: 'Close' })
  expect(await items.count()).toBeGreaterThanOrEqual(6)
  const total = await items.count()
  await items.last().click()
  await expect(dialog).toBeHidden()
  // Smooth scrolling to the end of a long story takes a moment, and the observer settles after it.
  await expect(picker).toHaveText(new RegExp(`Chapter ${total} of ${total}`), { timeout: 15_000 })
})

/** VT: reload mid-story restores scroll position within 200px. */
test('reloading mid-story restores the scroll position within 200px', async ({ page }) => {
  await openFirstStory(page)

  // Scroll a long way in and wait for the debounced save to land.
  const depth = await page.evaluate(() => Math.round(document.body.scrollHeight * 0.45))
  const target = await scrollToAndPersist(page, depth)
  expect(target).toBeGreaterThan(500)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'True facts from the story' })).toBeVisible()
  await expect
    .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - target), {
      timeout: 10_000,
    })
    .toBeLessThan(200)
})

test('scroll memory is per story, so opening another one starts at the top', async ({ page }) => {
  await openFirstStory(page)
  const target = await scrollToAndPersist(page, 1200)
  expect(target).toBeGreaterThan(1000)

  await page.goto('/library')
  const second = page.getByRole('link', { name: /read/i }).nth(1)
  await second.click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(200)
})

test('the true-facts checklist ticks, counts and survives a reload', async ({ page }) => {
  await openFirstStory(page)
  const facts = page.getByRole('checkbox')
  const total = await facts.count()

  await expect(page.getByText(`0 of ${total} ticked`)).toBeVisible()
  await facts.nth(0).check()
  await facts.nth(2).check()
  await expect(page.getByText(`2 of ${total} ticked`)).toBeVisible()

  await page.reload()
  await expect(page.getByText(`2 of ${total} ticked`)).toBeVisible()
  await expect(page.getByRole('checkbox').nth(0)).toBeChecked()
  await expect(page.getByRole('checkbox').nth(1)).not.toBeChecked()

  await page.getByRole('button', { name: 'Clear ticks' }).click()
  await expect(page.getByText(`0 of ${total} ticked`)).toBeVisible()
})

test('reading mode dims the UI, enlarges the text, and survives a reload', async ({ page }) => {
  await openFirstStory(page)

  const proseSize = () =>
    page.evaluate(() => {
      const prose = document.querySelector('.prose')
      return prose ? parseFloat(getComputedStyle(prose).fontSize) : 0
    })
  const before = await proseSize()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()

  await page.getByRole('button', { name: 'Reading mode' }).click()

  // Chrome is gone from the layout (and therefore from the a11y tree), and the text is bigger.
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).first()).toBeHidden()
  expect(await proseSize()).toBeGreaterThan(before)

  // Reading mode persists, and the way out is still on screen.
  await page.reload()
  await expect(page.getByRole('button', { name: 'Done reading' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  expect(await proseSize()).toBeGreaterThan(before)

  await page.getByRole('button', { name: 'Done reading' }).click()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  expect(await proseSize()).toBeCloseTo(before, 0)
})

test('the dark theme applies without a reload and persists', async ({ page }) => {
  await openFirstStory(page)
  await page.getByRole('radio', { name: 'Light' }).first().click()
  const light = await bodyBackgroundRgb(page)
  await page.getByRole('radio', { name: 'Dark' }).first().click()
  const dark = await bodyBackgroundRgb(page)
  expect(dark).not.toEqual(light)

  // A dark theme has to actually be dark, not merely different.
  expect(relativeLuminance(dark)).toBeLessThan(90)
  expect(relativeLuminance(light)).toBeGreaterThan(200)

  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await bodyBackgroundRgb(page)).toEqual(dark)
  // Applied before paint by the inline script, so there is no light flash to fix afterwards.
  expect(await page.getAttribute('html', 'data-theme')).toBe('dark')
})

test('the text-size control changes the prose size and remembers it', async ({ page }) => {
  await openFirstStory(page)
  const proseSize = () =>
    page.evaluate(() => {
      const prose = document.querySelector('.prose')
      return prose ? parseFloat(getComputedStyle(prose).fontSize) : 0
    })
  const before = await proseSize()
  await page.getByRole('button', { name: 'Larger text' }).click()
  const bigger = await proseSize()
  expect(bigger).toBeGreaterThan(before)

  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await proseSize()).toBeCloseTo(bigger, 0)
})

test('"Read again" returns to the top and is free', async ({ page }) => {
  await openFirstStory(page)
  const before = await mockState(page)

  await page.evaluate(() => window.scrollTo(0, 1500))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
  await page.getByRole('button', { name: 'Read again' }).click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(200)

  // Re-reading never reaches the model.
  const after = await mockState(page)
  expect(after.model_calls).toBe(before.model_calls)
  expect(after.quota_used).toBe(before.quota_used)
})

test('deleting a story removes it from the library and 404s its URL', async ({ page }) => {
  await openFirstStory(page)
  const title = (await page.getByRole('heading', { level: 1 }).innerText()).trim()
  const url = page.url()

  await page.getByRole('button', { name: 'Delete story' }).click()
  // Two steps, and the confirmation says what deletion does and does not do.
  await expect(page.getByText(/deleting a story doesn.t rewind the series/i)).toBeVisible()
  await page.getByRole('button', { name: 'Yes, delete it' }).click()

  await expect(page).toHaveURL(/\/library$/)
  await expect(page.getByRole('link').filter({ hasText: title })).toHaveCount(0)
  // Other stories are untouched.
  await expect(page.getByRole('link', { name: /read/i }).first()).toBeVisible()

  await page.goto(url)
  await expect(page.getByRole('heading', { name: /isn.t here any more/i })).toBeVisible()
  const apiResponse = await page.request.get(`/api/mock/stories/${url.split('/').pop()}`)
  expect(apiResponse.status()).toBe(404)
})

test('cancelling the delete keeps the story', async ({ page }) => {
  await openFirstStory(page)
  const title = (await page.getByRole('heading', { level: 1 }).innerText()).trim()
  await page.getByRole('button', { name: 'Delete story' }).click()
  await page.getByRole('button', { name: 'Keep it' }).click()
  await expect(page.getByRole('button', { name: 'Delete story' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
})

test('the library has no horizontal overflow', async ({ page }) => {
  const overflow = await horizontalOverflow(page)
  expect(
    overflow.widest,
    `element overflows the viewport: ${JSON.stringify(overflow.widest)}`,
  ).toBeNull()
  expect(overflow.documentOverflows).toBe(false)
})

test('a story URL that does not exist says so kindly', async ({ page }) => {
  await page.goto('/stories/00000000-0000-4000-8000-000000000999')
  await expect(page.getByRole('heading', { name: /isn.t here any more/i })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to the library' })).toBeVisible()
})
