import { expect, test } from '@playwright/test'

/**
 * VT-R1 (issue #17): lastten.org's landing page. One headline, the mission, one action that
 * leads to the creator, no child data, and questions that work from the keyboard.
 */

test.describe('landing page', () => {
  test('one headline, the mission, and one primary action that leads to the creator', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1, name: /last ten minutes of the day/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Our mission' })).toBeVisible()
    await expect(page.getByText(/stay curious about the world/i)).toBeVisible()

    // The same action at the top and at the bottom; nothing else is styled as primary.
    const actions = page.locator('a.st-primary')
    await expect(actions).toHaveCount(2)
    for (const action of await actions.all()) {
      await expect(action).toHaveAccessibleName(/make tonight.s book/i)
      await expect(action).toHaveAttribute('href', '/new')
    }
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    await expect(page.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy')
  })

  test('the sample is labelled as a sample and no account data is on the page', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('A sample of a bedtime book').first()).toBeVisible()
    // The mock backend's family is Milo, Juno and Theo; only the labelled sample may name anyone.
    await expect(page.getByText('Theo')).toHaveCount(0)
    // Visible text only: `textContent` would also read Next's inline data scripts.
    const everything = await page.locator('body').innerText()
    const sample = await page.locator('.st-sample').innerText()
    expect(everything.replace(sample, '')).not.toMatch(/Milo|Juno/)
  })

  test('the account-deleted notice is kept', async ({ page }) => {
    await page.goto('/?deleted=1')
    await expect(page.getByRole('status').filter({ hasText: /has been deleted/i })).toBeVisible()
    await page.goto('/')
    await expect(page.getByText(/has been deleted/i)).toHaveCount(0)
  })

  test('the questions open and close from the keyboard', async ({ page }) => {
    await page.goto('/')
    const second = page.locator('details.lt-q').nth(1)
    const answer = second.locator('.lt-a')
    await expect(answer).toBeHidden()
    await second.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(answer).toBeVisible()
    await expect(answer).toContainText(/no surname/i)
    await page.keyboard.press('Enter')
    await expect(answer).toBeHidden()
  })

  test('the in-page links reach the mission and the steps', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Read our mission' }).click()
    await expect(page).toHaveURL(/#mission$/)
    await expect(page.locator('#mission')).toBeInViewport()
  })
})

test.describe('the app shell', () => {
  test('the creator is one tap away from every page, on a phone too', async ({ page }) => {
    await page.goto('/privacy')
    const link = page.getByRole('link', { name: 'Tonight’s book' })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', '/new')
    await expect(page.getByRole('link', { name: 'Library' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Account and settings' })).toBeVisible()
  })

  test('in the reader, the footer clears the chapter bar that is fixed to the bottom', async ({ page }) => {
    await page.goto('/library')
    await page.getByRole('link', { name: /read/i }).first().click()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('[data-reader]')).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const bar = (await page.getByTestId('chapters-bar').boundingBox())!
    for (const name of ['Privacy', 'Our mission']) {
      const link = (await page.locator('footer.st-footer').getByRole('link', { name }).boundingBox())!
      expect(link.y + link.height, `${name} sits above the chapter bar`).toBeLessThanOrEqual(bar.y + 1)
    }
    const theme = (await page.locator('footer.st-footer').getByRole('radiogroup', { name: 'Theme' }).boundingBox())!
    expect(theme.y + theme.height).toBeLessThanOrEqual(bar.y + 1)
  })
})
