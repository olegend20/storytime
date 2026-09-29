import { expect, test } from '@playwright/test'
import {
  deleteTestUser,
  localAuthStackReachable,
  signInWithMagicLink,
  SKIP_REASON,
  uniqueEmail,
} from './support/login'

/**
 * F2 e2e VT: "magic-link login flow with Supabase's local inbucket; lands on dashboard."
 * Plus the F2 AC "unauthenticated users can only see the landing page and login."
 */

test.describe('F2 authentication', () => {
  test('an unauthenticated visitor sees the landing page and can reach login', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'StoryTime' })).toBeVisible()
    await page.getByRole('link', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByLabel('Email address')).toBeVisible()
  })

  test('the privacy page is readable without an account', async ({ page }) => {
    await page.goto('/privacy')
    await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible()
    await expect(page.getByText('first names only', { exact: false }).first()).toBeVisible()
  })

  test.describe('protected pages redirect to login', () => {
    for (const path of ['/dashboard', '/children', '/settings']) {
      test(`${path} redirects an unauthenticated visitor`, async ({ page }) => {
        await page.goto(path)
        // The `next` parameter is URL-encoded by NextResponse, so /dashboard arrives as
        // %2Fdashboard. Compare on the parsed value rather than pattern-matching the raw URL.
        const url = new URL(page.url())
        expect(url.pathname).toBe('/login')
        expect(url.searchParams.get('next')).toBe(path)
      })
    }
  })

  test('shows that Google sign-in is not enabled on this deployment', async ({ page }) => {
    // The provider is wired up in LoginForm but ships disabled: config.toml has
    // [auth.external.google] enabled = false, and NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED is
    // false by default. Turning it on is a config change, not a code change.
    await page.goto('/login')
    await expect(page.getByText('Google sign-in is not enabled on this deployment.')).toBeVisible()
  })

  test('magic-link login lands on the dashboard', async ({ page }) => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
    const email = uniqueEmail('login')
    try {
      await signInWithMagicLink(page, email)
      await expect(page.getByRole('heading', { name: 'My family' })).toBeVisible()
      await expect(page.getByText('No children yet')).toBeVisible()

      // Re-visiting /login while signed in goes back to the dashboard, and the second
      // visit must not have created a second family (F2 AC) - the page would fail to
      // render at all if `ensureFamily` had found two rows.
      await page.goto('/login')
      await expect(page).toHaveURL(/\/dashboard$/)
      await expect(page.getByRole('heading', { name: 'My family' })).toBeVisible()
    } finally {
      await deleteTestUser(email)
    }
  })

  test('signing out returns to the landing page and re-protects the dashboard', async ({
    page,
  }) => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
    const email = uniqueEmail('signout')
    try {
      await signInWithMagicLink(page, email)
      await page.goto('/settings')
      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(/\/$/)
      await page.goto('/dashboard')
      await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/)
    } finally {
      await deleteTestUser(email)
    }
  })

  test('family settings save the display name and a timezone', async ({ page }) => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
    const email = uniqueEmail('settings')
    try {
      await signInWithMagicLink(page, email)
      await page.goto('/settings')
      await page.getByLabel('Family name').fill('The Test Family')
      await page.getByLabel('Timezone').selectOption('Europe/London')
      await page.getByRole('button', { name: 'Save settings' }).click()
      await expect(page.getByText('Saved.')).toBeVisible()

      await page.reload()
      await expect(page.getByLabel('Family name')).toHaveValue('The Test Family')
      await expect(page.getByLabel('Timezone')).toHaveValue('Europe/London')
      await page.goto('/dashboard')
      await expect(page.getByRole('heading', { name: 'The Test Family' })).toBeVisible()
    } finally {
      await deleteTestUser(email)
    }
  })

  test('deleting the account removes it and locks the dashboard again', async ({ page }) => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
    const email = uniqueEmail('delete')
    try {
      await signInWithMagicLink(page, email)

      // Something to delete.
      await page.goto('/children')
      await page.getByLabel('First name').fill('Cruz')
      await page.getByLabel('Age').fill('7')
      await page.getByRole('button', { name: 'Add child' }).click()
      await expect(page.getByTestId('child-row')).toHaveCount(1)

      await page.goto('/settings')
      const deleteButton = page.getByRole('button', { name: 'Delete account' })
      await expect(deleteButton).toBeDisabled()
      await page.getByLabel('Type delete to confirm').fill('delete')
      await expect(deleteButton).toBeEnabled()
      await deleteButton.click()

      await expect(page).toHaveURL(/\/\?deleted=1$/)
      await expect(page.getByText('Your account and everything in it has been deleted')).toBeVisible()

      // The session is gone, so the dashboard is behind login again.
      await page.goto('/dashboard')
      await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/)
    } finally {
      await deleteTestUser(email)
    }
  })
})
