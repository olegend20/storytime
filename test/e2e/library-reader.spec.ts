import { expect, test, type Page } from '@playwright/test'
import {
  bodyBackgroundRgb,
  horizontalOverflow,
  mockState,
  relativeLuminance,
  resetMock,
  chooseTheme,
  openStoryActions,
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
  // Streams a whole 2,600-word story to completion. Mobile WebKit, rendering that incrementally
  // under five parallel workers, does not fit the default 30s budget.
  test.slow()
  await page.goto('/new')
  await page.getByTestId('heroes').waitFor()
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
  await expect(page.getByRole('heading', { name: 'Milo & Juno' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Theo', exact: true })).toBeVisible()

  const seriesSections = page.locator('section[aria-labelledby^="series-"]')
  await expect(seriesSections).toHaveCount(2)
  await expect(seriesSections.first().getByText(/2 books together/)).toBeVisible()
})

/** VT-R7 (issue #17): what a row offers follows what this parent has actually done with the book. */
test('a row says Read for an unopened book, Continue reading part-way in, and Read again after', async ({
  page,
}) => {
  const first = page.locator('.st-row').first()
  // Never opened in this browser: plain "Read" - "again" would not be true.
  await expect(first.locator('.st-row-action')).toHaveText('Read')
  // (Scoped to the rows: the page's own line says "ready to read again".)
  await expect(page.locator('.st-row-action').filter({ hasText: /Continue reading|Read again/ })).toHaveCount(0)
  // Each row carries a text cover (no image), the real read time and the real fact count.
  await expect(first.locator('.st-cover')).toHaveAttribute('data-tint', /sage|mist|sand/)
  await expect(first.locator('img')).toHaveCount(0)
  await expect(first).toContainText(/\d+ min read aloud/)
  await expect(first).toContainText(/\d+ true facts/)

  const before = await mockState(page)
  await openFirstStory(page)
  await scrollToAndPersist(page, 1500)
  await page.goto('/library')
  await expect(page.locator('.st-row').first().locator('.st-row-action')).toHaveText('Continue reading')
  await expect(page.locator('.st-row').nth(1).locator('.st-row-action')).toHaveText('Read')

  // Continue resumes; "Read again" in the story sends it back to the top and the row follows.
  await page.locator('.st-row').first().click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.getByRole('button', { name: 'Read again' }).click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(200)
  await page.goto('/library')
  await expect(page.locator('.st-row').first().locator('.st-row-action')).toHaveText('Read again')

  // None of it reached the model or the quota.
  const after = await mockState(page)
  expect(after.model_calls).toBe(before.model_calls)
  expect(after.quota_used).toBe(before.quota_used)
})

/** VT-R8 (issue #17): read together keeps exactly what is needed to read and to get back out. */
test('read together keeps Done reading, text size and the chapter bar, and nothing else', async ({ page }) => {
  await openFirstStory(page)
  await page.getByRole('button', { name: 'Read together' }).click()
  await expect(page.getByRole('button', { name: 'Done reading' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Larger text' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Smaller text' })).toBeVisible()
  await expect(page.getByTestId('chapters-bar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Next chapter' })).toBeEnabled()
  for (const gone of ['theme-menu', 'story-actions']) await expect(page.getByTestId(gone)).toBeHidden()
  await expect(page.getByRole('link', { name: 'Back to the library' })).toBeHidden()
  await expect(page.locator('footer.st-footer')).toBeHidden()
  // The chapter bar still works from here.
  await page.getByRole('button', { name: 'Next chapter' }).click()
  await expect(page.getByRole('button', { name: /^Chapter 2 of \d+$/ })).toBeVisible()
})

test('all four themes and all five text sizes are there, and the choice persists', async ({ page }) => {
  await openFirstStory(page)
  await page.getByTestId('theme-menu').locator('summary').click()
  await expect(page.getByTestId('theme-menu').getByRole('radio')).toHaveText(['Auto', 'Light', 'Dark', 'Night'])
  await page.keyboard.press('Escape')

  // Five steps: from the smallest, "Larger text" can be pressed exactly four times.
  const larger = page.getByRole('button', { name: 'Larger text' })
  const smaller = page.getByRole('button', { name: 'Smaller text' })
  while (await smaller.isEnabled()) await smaller.click()
  let steps = 1
  while (await larger.isEnabled()) {
    await larger.click()
    steps += 1
  }
  expect(steps).toBe(5)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Larger text' })).toBeDisabled()
})

test('only one reader menu is open at a time, and arrow keys on a menu button do not turn the chapter', async ({
  page,
}) => {
  await openFirstStory(page)
  const theme = page.getByTestId('theme-menu')
  const actions = page.getByTestId('story-actions')
  await theme.locator('summary').click()
  await expect(theme).toHaveAttribute('open', '')
  await actions.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(actions).toHaveAttribute('open', '')
  await expect(theme).not.toHaveAttribute('open', '')

  await page.keyboard.press('Escape')
  await expect(actions).not.toHaveAttribute('open', '')
  await expect(actions.locator('summary')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('button', { name: /^Chapter 1 of \d+$/ })).toBeVisible()
})

test('the chapter label is never squeezed, even with many chapters on a mid-size phone', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 860 })
  await openFirstStory(page)
  const label = page.getByTestId('chapters-bar').locator('.truncate')
  const clipped = await label.evaluate((el) => el.scrollWidth > el.clientWidth)
  expect(clipped).toBe(false)
  await expect(label).toHaveText(/^Chapter \d+ of \d+$/)
})

test('the chapter bar never covers the end of the story or its last buttons', async ({ page }) => {
  await openFirstStory(page)
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const bar = (await page.getByTestId('chapters-bar').boundingBox())!
  for (const name of ['Read again', 'Clear ticks']) {
    const button = page.getByRole('button', { name })
    if ((await button.count()) === 0) continue
    const box = (await button.boundingBox())!
    expect(box.y + box.height, `${name} is clear of the chapter bar`).toBeLessThanOrEqual(bar.y)
  }
  const another = (await page.getByRole('link', { name: /make another book/i }).boundingBox())!
  expect(another.y + another.height).toBeLessThanOrEqual(bar.y)
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

  await page.getByRole('button', { name: 'Read together' }).click()

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
  await chooseTheme(page, 'Light')
  const light = await bodyBackgroundRgb(page)
  await chooseTheme(page, 'Dark')
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

  await openStoryActions(page)
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

test('a delete that fails says so on the page, where it stays once the menu has closed', async ({ page }) => {
  await openFirstStory(page)
  const title = (await page.getByRole('heading', { level: 1 }).innerText()).trim()
  // A real failure rather than an intercepted one (the service worker makes the request, so
  // interception is not dependable): remove the story behind the page's back, so the page's
  // own delete is refused by the server.
  const gone = await page.request.delete(`/api/mock/stories/${page.url().split('/').pop()}`)
  expect(gone.ok()).toBe(true)
  await openStoryActions(page)
  await page.getByRole('button', { name: 'Delete story' }).click()
  await page.getByRole('button', { name: 'Yes, delete it' }).click()
  const alert = page.getByTestId('delete-error')
  await expect(alert).toBeVisible()
  await expect(alert).toHaveAttribute('role', 'alert')

  // Close the menu: the message is on the page, not in it, and the story is still here.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('story-actions')).not.toHaveAttribute('open', '')
  await expect(alert).toBeVisible()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
})

test('cancelling the delete keeps the story', async ({ page }) => {
  await openFirstStory(page)
  const title = (await page.getByRole('heading', { level: 1 }).innerText()).trim()
  await openStoryActions(page)
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
  // "Kindly" is for a signed-in parent. With no session at all, F11 redirects to login
  // instead (api-guards.spec.ts) - so establish the mock session first.
  await resetMock(page)
  await page.goto('/stories/00000000-0000-4000-8000-000000000999')
  await expect(page.getByRole('heading', { name: /isn.t here any more/i })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to the library' })).toBeVisible()
})

// ---------------------------------------------------------------------------------------
// Reading on a phone in a dark bedroom (DECISIONS #143-#147)
// ---------------------------------------------------------------------------------------

test('the screen stays awake while a story is open, and is released on leaving', async ({ page }) => {
  // The Wake Lock API, recorded: a real lock cannot be observed from a test.
  await page.addInitScript(() => {
    const log: string[] = []
    ;(window as unknown as { __wake: string[] }).__wake = log
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        async request(type: string) {
          log.push(`request:${type}`)
          const listeners: (() => void)[] = []
          return {
            released: false,
            async release() {
              this.released = true
              log.push('release')
              listeners.forEach((l) => l())
            },
            addEventListener(_t: string, l: () => void) {
              listeners.push(l)
            },
          }
        },
      },
    })
  })
  await page.reload() // the init script applies from the next navigation
  await openFirstStory(page)
  const log = () => page.evaluate(() => (window as unknown as { __wake: string[] }).__wake)
  await expect.poll(log).toContain('request:screen')
  await page.getByRole('link', { name: 'Library' }).first().click()
  await expect(page.getByRole('heading', { name: 'Story library' })).toBeVisible()
  await expect.poll(log).toContain('release')
})

test('the night theme is near-black with warm text, and persists', async ({ page }) => {
  await openFirstStory(page)
  await chooseTheme(page, 'Night')
  expect(await page.getAttribute('html', 'data-theme')).toBe('night')
  const bg = await bodyBackgroundRgb(page)
  expect(relativeLuminance(bg)).toBeLessThan(25)
  const fg = await page.evaluate(() => getComputedStyle(document.querySelector('.prose')!).color)
  // Warm: more red than blue, and dimmed: not white.
  const [r, , b] = fg.match(/\d+/g)!.map(Number) as [number, number, number]
  expect(r).toBeGreaterThan(b)
  expect(r).toBeLessThan(235)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.getAttribute('html', 'data-theme')).toBe('night')
})

test('a sideways swipe turns the chapter; a vertical one does not', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'touch only')
  await openFirstStory(page)
  await expect(page.getByText(/^Chapter 1 of \d+$/)).toBeVisible()
  const swipe = (from: [number, number], to: [number, number]) =>
    page.evaluate(
      ([a, b]) => {
        const el = document.querySelector('[data-testid="chapters"]')!
        const ev = (type: string, x: number, y: number) =>
          new PointerEvent(type, { bubbles: true, pointerType: 'touch', pointerId: 1, clientX: x, clientY: y })
        el.dispatchEvent(ev('pointerdown', a[0], a[1]))
        el.dispatchEvent(ev('pointerup', b[0], b[1]))
      },
      [from, to] as const,
    )
  await swipe([300, 400], [300, 200]) // a scroll
  await expect(page.getByText(/^Chapter 1 of \d+$/)).toBeVisible()
  await swipe([300, 400], [120, 404]) // a page turn
  await expect(page.getByText(/^Chapter 2 of \d+$/)).toBeVisible()
  await swipe([100, 400], [300, 396]) // and back
  await expect(page.getByText(/^Chapter 1 of \d+$/)).toBeVisible()
})

test('installable: a manifest, icons, and full-screen on iOS', async ({ page, request }) => {
  await page.goto('/library')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /manifest\.webmanifest/)
  // Next emits the current name; iOS 16.4+ honours it, older iOS reads the apple- prefix.
  await expect(page.locator('meta[name="mobile-web-app-capable"], meta[name="apple-mobile-web-app-capable"]').first()).toHaveAttribute('content', 'yes')
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'StoryTime')
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/)
  const manifest = await request.get('/manifest.webmanifest')
  expect(manifest.ok()).toBe(true)
  const body = (await manifest.json()) as { display: string; start_url: string; icons: { src: string }[] }
  expect(body.display).toBe('standalone')
  expect(body.start_url).toBe('/library')
  for (const icon of body.icons) {
    const res = await request.get(icon.src)
    expect(res.ok(), icon.src).toBe(true)
    expect(res.headers()['content-type'], icon.src).toContain('image/png')
  }
})

test('a saved story reads with no signal', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers are exercised on Chromium')
  await page.goto('/library')
  await resetMock(page)
  await page.reload()
  // The worker registers on a production build; wait until it controls this page.
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 15_000 })
  await openFirstStory(page) // waits for the story itself, not the library's own heading
  const title = (await page.getByRole('heading', { level: 1 }).innerText()).trim()
  await page.reload() // once more, controlled, so the story and its page are cached
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'True facts from the story' })).toBeVisible({ timeout: 15_000 })
  await context.setOffline(false)
})

// ---------------------------------------------------------------------------------------
// Send to Kindle (issue #11) - the button on a saved story, against the mock backend
// ---------------------------------------------------------------------------------------

test('Send to Kindle reports where the story went, and links to Settings when no address is set', async ({ page }) => {
  // The newest story (…0001) has a Kindle address in the mock; …0000 does not.
  await page.goto('/stories/833fa5ee-0001-4000-8000-833fa5ee0001')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await openStoryActions(page)
  await page.getByTestId('send-to-kindle').click()
  await expect(page.getByTestId('kindle-sent')).toContainText('Sent to mock_family@kindle.com')

  await page.goto('/stories/a2117f05-0000-4000-8000-a2117f050000')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await openStoryActions(page)
  await page.getByTestId('send-to-kindle').click()
  await expect(page.getByTestId('kindle-error')).toContainText('Add your Kindle address')
  await expect(page.getByRole('link', { name: 'Add it in Settings' })).toHaveAttribute('href', '/settings')
  // The outcome is on the page, not in the menu: it is still there once the menu has closed.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('story-actions')).not.toHaveAttribute('open', '')
  await expect(page.getByTestId('kindle-error')).toBeVisible()
  await expect(page.getByTestId('kindle-error')).toHaveAttribute('role', 'alert')
  // Reading mode hides the chrome, the menu and its button with it.
  await page.getByRole('button', { name: 'Read together' }).click()
  await expect(page.getByTestId('story-actions')).toBeHidden()
  await expect(page.getByTestId('send-to-kindle')).toBeHidden()
})
