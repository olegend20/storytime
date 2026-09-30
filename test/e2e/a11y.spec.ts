import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { resetMock, startStory } from './helpers'

/**
 * F10 VT: "axe-core scan of the form and reader pages reports no serious violations."
 *
 * The bar in the VT is "no serious", and the assertion below is on `serious` and `critical`.
 * Moderate and minor findings are printed so a regression is visible without failing the build on
 * something axe itself describes as advisory.
 */

async function scan(page: Page, context?: string) {
  const builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
  ])
  if (context) builder.include(context)
  return builder.analyze()
}

function report(name: string, violations: Awaited<ReturnType<typeof scan>>['violations']) {
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const advisory = violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical')
  if (advisory.length > 0) {
    console.log(
      `[a11y] ${name} — advisory: ` +
        advisory.map((v) => `${v.id}(${v.impact}, ${v.nodes.length})`).join(', '),
    )
  }
  return blocking.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4),
  }))
}

test.describe('accessibility', () => {
  test('the new-story form has no serious violations', async ({ page }) => {
    await page.goto('/new')
    await resetMock(page)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Milo 7' })).toBeVisible()
    const results = await scan(page)
    expect(report('form', results.violations)).toEqual([])
  })

  test('the form with an error showing has no serious violations', async ({ page }) => {
    test.slow()
    await page.goto('/new')
    await resetMock(page)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Milo 7' })).toBeVisible()
    await startStory(page, '!refuse a topic')
    // Next injects its own empty role="alert" route announcer, so match on our copy.
    await expect(
      page.getByRole('alert').filter({ hasText: /can.t make a story about that/i }),
    ).toBeVisible()
    const results = await scan(page)
    expect(report('form+error', results.violations)).toEqual([])
  })

  test('the form at the quota limit has no serious violations', async ({ page }) => {
    await page.goto('/new')
    await resetMock(page)
    await page.request.post('/api/mock/debug', { data: { quota_used: 3 } })
    await page.reload()
    await expect(page.getByRole('button', { name: 'Start the story' })).toBeDisabled()
    const results = await scan(page)
    expect(report('form+quota', results.violations)).toEqual([])
  })

  test('the reader has no serious violations', async ({ page }) => {
    await page.goto('/library')
    await resetMock(page)
    await page.reload()
    await page.getByRole('link', { name: /read/i }).first().click()
    await expect(page.getByRole('heading', { name: 'True facts from the story' })).toBeVisible()
    const results = await scan(page)
    expect(report('reader', results.violations)).toEqual([])
  })

  test('the reader in dark reading mode has no serious violations', async ({ page }) => {
    // The night-time configuration is the one this app is actually used in, so it gets its own
    // scan: dimmed backgrounds are exactly where contrast regressions hide.
    await page.goto('/library')
    await resetMock(page)
    await page.reload()
    await page.getByRole('link', { name: /read/i }).first().click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.getByRole('radio', { name: 'Dark' }).first().click()
    await page.getByRole('button', { name: 'Reading mode' }).click()
    await expect(page.getByRole('button', { name: 'Done reading' })).toBeVisible()
    const results = await scan(page)
    expect(report('reader+dark+reading', results.violations)).toEqual([])
  })

  test('the reader with the chapter picker open has no serious violations', async ({ page }) => {
    await page.goto('/library')
    await resetMock(page)
    await page.reload()
    await page.getByRole('link', { name: /read/i }).first().click()
    await page.getByRole('button', { name: /^Chapter \d+ of \d+$/ }).click()
    await expect(page.getByRole('dialog', { name: 'Chapters' })).toBeVisible()
    const results = await scan(page)
    expect(report('reader+chapters', results.violations)).toEqual([])
  })

  test('tic-tac-toe while the writer thinks has no serious violations', async ({ page }) => {
    await page.goto('/new')
    await resetMock(page)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Milo 7' })).toBeVisible()
    await startStory(page, '!thinking the history of soccer')
    await expect(page.getByTestId('ttt-board')).toBeVisible()
    await page.getByTestId('ttt-cell-0').click()
    const results = await scan(page)
    expect(report('tic-tac-toe', results.violations)).toEqual([])
  })

  test('the streaming reader has no serious violations', async ({ page }) => {
    test.slow()
    await page.goto('/new')
    await resetMock(page)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Milo 7' })).toBeVisible()
    await startStory(page, 'the history of soccer')
    await expect(page.getByRole('progressbar', { name: 'Writing the story' })).toBeVisible()
    const results = await scan(page)
    expect(report('streaming', results.violations)).toEqual([])
  })

  test('the library has no serious violations', async ({ page }) => {
    await page.goto('/library')
    await resetMock(page)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Story library' })).toBeVisible()
    const results = await scan(page)
    expect(report('library', results.violations)).toEqual([])
  })

  test('the home and privacy pages have no serious violations', async ({ page }) => {
    await page.goto('/')
    expect(report('home', (await scan(page)).violations)).toEqual([])
    await page.goto('/privacy')
    expect(report('privacy', (await scan(page)).violations)).toEqual([])
  })

  test('the reader is navigable by keyboard alone', async ({ page }) => {
    await page.goto('/library')
    await resetMock(page)
    await page.reload()
    await page.getByRole('link', { name: /read/i }).first().click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    // The skip link is the first focusable element in the document, and using it lands on the
    // story. Focused directly rather than via Tab: a headless page that has never been clicked
    // has focus on the document, and the first Tab then goes nowhere.
    const firstFocusableIsSkipLink = await page.evaluate(() => {
      const focusable = document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      return focusable[0]?.textContent?.trim() ?? null
    })
    expect(firstFocusableIsSkipLink).toBe('Skip to content')

    const skip = page.getByRole('link', { name: 'Skip to content' })
    await skip.focus()
    await expect(page.locator(':focus')).toHaveText('Skip to content')
    // Off-screen until focused, then a real visible target rather than a 1px trap. Polled because
    // it slides in over 120ms, so the box is still mid-transition on the first read.
    await expect.poll(async () => (await skip.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0)
    expect((await skip.boundingBox())?.height ?? 0).toBeGreaterThan(20)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/#main$/)

    // Arrow keys move between chapters when focus is not in a control.
    await page.locator('h1').click()
    const picker = page.getByRole('button', { name: /^Chapter \d+ of \d+$/ })
    await page.keyboard.press('ArrowRight')
    await expect(picker).toHaveText(/Chapter 2 of \d+/)
    await page.keyboard.press('ArrowLeft')
    await expect(picker).toHaveText(/Chapter 1 of \d+/)
  })
})
