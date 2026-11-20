import { expect, test } from '@playwright/test'

/**
 * VT-FB4: lastten.org/feedback opens without signing in, sends what the tester chose, and
 * thanks them. The API is stubbed here (the mock e2e build has no real database); the stored
 * row is test/int/feedback.test.ts.
 */

test.describe('tester feedback page', () => {
  test('opens signed out, sends the answers, and says thank you', async ({ page }) => {
    let sent: Record<string, unknown> | null = null
    await page.route('**/api/feedback', async (route) => {
      sent = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    await page.goto('/feedback')
    await expect(page).toHaveURL(/\/feedback$/)
    await expect(page.getByRole('heading', { level: 1, name: /thank you for reading with us/i })).toBeVisible()

    await page.getByRole('radio', { name: 'We love it' }).check()
    await page.getByRole('checkbox', { name: 'Kindle or other e-reader' }).check()
    await page.getByLabel('What did your child enjoy most?').fill('The volcano facts')
    await page.getByRole('button', { name: /send feedback/i }).click()

    await expect(page.getByRole('status')).toContainText(/your feedback has reached us/i)
    expect(sent).toMatchObject({ enjoyment: 'loved', reading_on: ['ereader'], loved: 'The volcano facts' })
  })

  test('shows the server’s message when nothing was answered', async ({ page }) => {
    await page.route('**/api/feedback', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'invalid_request', message: 'Please answer at least one question before sending.', field: 'form' }),
      }),
    )
    await page.goto('/feedback')
    await page.getByRole('button', { name: /send feedback/i }).click()
    await expect(page.getByRole('alert')).toContainText(/at least one question/i)
  })
})
