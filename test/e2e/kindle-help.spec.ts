import { expect, test } from '@playwright/test'
import { openStoryActions, resetMock } from './helpers'

/**
 * lastten.org/kindle (issue #117): the Send to Kindle instructions. This suite's server has no
 * mail set up, so the page must say so rather than show steps with no address in them; the
 * page with its address is checked on the real stack (test/e2e-real/kindle.spec.ts).
 */

test('the Kindle instructions open without signing in and say when sending is not switched on', async ({ page }) => {
  await page.context().clearCookies()
  const response = await page.goto('/kindle')
  expect(response?.status()).toBe(200)
  await expect(page).toHaveURL(/\/kindle$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1, name: /on a Kindle/i })).toBeVisible()
  // One header and one footer: the app's, not the landing page's on top of it.
  await expect(page.getByRole('banner')).toHaveCount(1)
  await expect(page.getByRole('contentinfo')).toHaveCount(1)
  await expect(page.getByTestId('kindle-off')).toContainText('not switched on here yet')
  // No address is configured, so none is shown - not even a placeholder.
  await expect(page.getByTestId('kindle-from')).toHaveCount(0)
  expect(await page.locator('main').innerText()).not.toMatch(/@/)
})

test('with no Kindle address saved, the message under the button links to the instructions', async ({ page }) => {
  await page.goto('/library')
  await resetMock(page)
  await page.goto('/stories/a2117f05-0000-4000-8000-a2117f050000')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await openStoryActions(page)
  await page.getByTestId('send-to-kindle').click()
  const error = page.getByTestId('kindle-error')
  await expect(error).toContainText('Add your Kindle address')
  await expect(error.getByRole('link', { name: 'how to set it up' })).toHaveAttribute('href', '/kindle')
})
