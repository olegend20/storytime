import { expect, test } from '@playwright/test'
import {
  deleteTestUser,
  localAuthStackReachable,
  signInWithMagicLink,
  SKIP_REASON,
  uniqueEmail,
} from './support/login'

/**
 * F3 e2e VT: "add two children, see both in the picker, edit one, delete one, confirm
 * list."
 *
 * "The picker" is F10's new-story form, which lane 4 owns and which does not exist yet, so
 * the dashboard's child chips stand in for it: they are the same list read back through a
 * different page, which is what the VT is really checking.
 */

test.describe('F3 children profiles', () => {
  test('add two, edit one, delete one', async ({ page }) => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
    const email = uniqueEmail('children')
    try {
      await signInWithMagicLink(page, email)
      await page.goto('/children')

      // ---------------------------------------------------------------- add two
      await page.getByLabel('First name').fill('Cruz')
      await page.getByLabel('Age').fill('7')
      await page.getByLabel('Likes', { exact: false }).fill('football')
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await page.getByLabel('Notes', { exact: false }).fill('Loves goalkeeping')
      await page.getByRole('button', { name: 'Add child' }).click()
      await expect(page.getByTestId('child-row')).toHaveCount(1)

      await page.getByRole('button', { name: 'Add a child' }).click()
      await page.getByLabel('First name').fill('Phoenix')
      await page.getByLabel('Age').fill('4')
      await page.getByRole('button', { name: 'Add child' }).click()
      await expect(page.getByTestId('child-row')).toHaveCount(2)

      const rows = page.getByTestId('child-row')
      await expect(rows.nth(0)).toContainText('Cruz')
      await expect(rows.nth(0)).toContainText('football')
      await expect(rows.nth(1)).toContainText('Phoenix')

      // ---------------------------------------------------------- both in the picker
      await page.goto('/dashboard')
      await expect(page.getByText('2 children')).toBeVisible()
      await expect(page.getByText('Cruz', { exact: false }).first()).toBeVisible()
      await expect(page.getByText('Phoenix', { exact: false }).first()).toBeVisible()

      // ---------------------------------------------------------------- edit one
      await page.goto('/children')
      await page.getByTestId('child-row').nth(0).getByRole('button', { name: 'Edit' }).click()
      await page.getByLabel('Age').fill('8')
      await page.getByRole('button', { name: 'Save changes' }).click()
      await expect(page.getByTestId('child-row').nth(0)).toContainText('8')
      await page.reload()
      await expect(page.getByTestId('child-row').nth(0)).toContainText('8')
      // The edit must not have blanked the fields it did not touch.
      await expect(page.getByTestId('child-row').nth(0)).toContainText('football')
      await expect(page.getByTestId('child-row').nth(0)).toContainText('Loves goalkeeping')

      // ---------------------------------------------------------------- delete one
      page.once('dialog', (dialog) => dialog.accept())
      await page.getByTestId('child-row').nth(1).getByRole('button', { name: 'Remove' }).click()
      await expect(page.getByTestId('child-row')).toHaveCount(1)
      await expect(page.getByText('Phoenix removed.')).toBeVisible()

      // ---------------------------------------------------------------- confirm list
      await page.reload()
      await expect(page.getByTestId('child-row')).toHaveCount(1)
      await expect(page.getByTestId('child-row').nth(0)).toContainText('Cruz')
      await page.goto('/dashboard')
      await expect(page.getByText('1 child')).toBeVisible()
    } finally {
      await deleteTestUser(email)
    }
  })

  test('the form refuses an invalid child before it reaches the server', async ({ page }) => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
    const email = uniqueEmail('children-validation')
    try {
      await signInWithMagicLink(page, email)
      await page.goto('/children')

      // Age 18 is out of range (F3 AC: 1-17). The same rule runs on the server.
      await page.getByLabel('First name').fill('Cruz')
      await page.getByLabel('Age').fill('18')
      await page.getByRole('button', { name: 'Add child' }).click()
      // Scoped to the form's own <p role="alert">: Next's route announcer is also an alert.
      const formError = page.locator('p[role="alert"]')
      await expect(formError).toContainText('Age must be between 1 and 17.')
      await expect(page.getByTestId('child-row')).toHaveCount(0)

      // A name with digits is rejected too (GUARDRAILS.md s3.2 character rule).
      await page.getByLabel('First name').fill('Cruz99')
      await page.getByLabel('Age').fill('7')
      await page.getByRole('button', { name: 'Add child' }).click()
      await expect(formError).toContainText('letters only')
      await expect(page.getByTestId('child-row')).toHaveCount(0)
    } finally {
      await deleteTestUser(email)
    }
  })
})
