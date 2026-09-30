import { expect, test } from '@playwright/test'

/** F1: the app builds and serves. Real e2e coverage arrives with F2/F9/F10. */
test('landing page renders', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'StoryTime' })).toBeVisible()
})

/** F9 AC: no horizontal scroll on a 375px phone. */
test('no horizontal overflow on mobile', async ({ page }) => {
  await page.goto('/')
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  )
  expect(overflows).toBe(false)
})
