import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import {
  deleteTestUser,
  extractSignInLink,
  fetchLatestEmailBody,
  localAuthStackReachable,
  signInWithMagicLink,
  SKIP_REASON,
  uniqueEmail,
} from '../e2e/support/login'
import { E2E_OWNER_EMAIL, E2E_OWNER_ID } from './owner'

/**
 * Issue #92 (VT-W8): lastten.org as it launches, on the real local stack - the coming-soon
 * page, the waitlist, the gate on sign-up, the owner's approval, the invite email, and the
 * approved parent signing in. Issue #95 (VT-W13): the address is confirmed by email before
 * the owner sees it. The server runs with WAITLIST_ENABLED=true and OWNER_USER_ID
 * set to the test owner (playwright.real.config.ts).
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const LOCAL_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_SERVICE_KEY
const admin = { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' }

async function accountExists(email: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, { headers: admin })
  const body = (await res.json()) as { users?: { email: string }[] }
  return (body.users ?? []).some((u) => u.email === email)
}

/** Poll the mailbox until the newest message to `email` is the confirmation; its link. */
async function confirmLink(email: string): Promise<string> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const link = (await fetchLatestEmailBody(email)).match(/https?:\/\/\S+\/waitlist\/confirm\?token=\S+/)?.[0]
    if (link) return link
    if (Date.now() > deadline) throw new Error('no confirmation email arrived')
    await new Promise((r) => setTimeout(r, 400))
  }
}

/** Poll the mailbox until the newest message to `email` is a sign-in link, not the invite. */
async function nextSignInLink(email: string): Promise<string> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const body = await fetchLatestEmailBody(email)
    if (/\/auth\/v1\/verify/.test(body)) return extractSignInLink(body)
    if (Date.now() > deadline) throw new Error('no sign-in email arrived after the invite')
    await new Promise((r) => setTimeout(r, 400))
  }
}

test.describe('issue #92: the coming-soon page and the approved waitlist', () => {
  test.beforeAll(async () => {
    if (!(await localAuthStackReachable())) return
    // The owner the server was started with. Already there on a re-run: that is fine.
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ id: E2E_OWNER_ID, email: E2E_OWNER_EMAIL, email_confirm: true }),
    })
  })

  test.beforeEach(async () => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
  })

  test('the coming-soon page: the message, one action, accessible, fits a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('last ten minutes of the day')
    await expect(page.getByRole('heading', { name: /encyclopedia/i })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Join the waitlist' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'no horizontal scroll at 375px').toBeLessThanOrEqual(0)

    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    const serious = scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(serious.map((v) => `${v.id}: ${v.help}`)).toEqual([])

    // The full homepage is one link away, and its buttons lead back to the waitlist.
    await page.getByRole('link', { name: 'Read more about the project' }).click()
    await expect(page).toHaveURL(/\/about$/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('last ten minutes of the day')
    await expect(page.getByRole('link', { name: /Join the waitlist/ }).first()).toHaveAttribute('href', '/#join')
  })

  test('join, confirm, refused until approved, approved by the owner, invited, signed in', async ({ page, browser }) => {
    const visitor = uniqueEmail('waitlist')
    try {
      // ---- 1. A visitor joins, and is asked to confirm by email.
      await page.goto('/')
      await page.getByLabel('Email for the waitlist').fill(visitor)
      await page.getByRole('button', { name: 'Join the waitlist' }).click()
      await expect(page.getByText('Check your email.')).toBeVisible()

      // ---- 1b. Issue #95: the emailed link opens a page with one button; pressing it confirms.
      // Opening the link alone confirms nothing (mail scanners open links).
      const link = await confirmLink(visitor)
      // Issue #98 (VT-E5): the designed email's one big button opens that same link.
      // Not waiting for the load event: the email's fonts and moons come from outside this stack.
      await page.setContent(await fetchLatestEmailBody(visitor, 20_000, 'html'), { waitUntil: 'domcontentloaded' })
      await expect(page.getByRole('heading', { name: 'One press and you are on the list.' })).toBeVisible()
      const [opened] = await Promise.all([
        page.waitForEvent('popup'),
        page.getByRole('link', { name: /^Confirm my place/ }).click(),
      ])
      await expect(opened).toHaveURL(link)
      await expect(opened.getByRole('heading', { name: 'Confirm your place' })).toBeVisible()
      await opened.close()
      await page.goto(link)
      await expect(page.getByRole('heading', { name: 'Confirm your place' })).toBeVisible()
      await page.getByRole('button', { name: 'Confirm my place' }).click()
      await expect(page.getByRole('heading', { name: 'You’re on the list.' })).toBeVisible()
      // The same link a second time: used.
      await page.goto(link)
      await page.getByRole('button', { name: 'Confirm my place' }).click()
      await expect(page.getByRole('heading', { name: /expired or was already used/ })).toBeVisible()

      // ---- 2. Signing in before approval: the same screen anyone sees (the page never says
      // who has an account), with the waitlist offered - and no account, and no link.
      await page.goto('/login')
      await page.getByLabel('Email address').fill(visitor)
      await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      await expect(page.getByText(/has a place, a sign-in link is on its way/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Join the waitlist' })).toBeVisible()
      expect(await accountExists(visitor)).toBe(false)

      // ---- 3. The owner approves at /admin/waitlist; the invite email goes out.
      const ownerContext = await browser.newContext()
      const owner = await ownerContext.newPage()
      await signInWithMagicLink(owner, E2E_OWNER_EMAIL, { approve: false })
      await owner.goto('/admin/waitlist')
      await expect(owner.getByRole('heading', { name: 'Waitlist' })).toBeVisible()
      await owner.getByRole('button', { name: `Approve: ${visitor}` }).click()
      await expect(owner.getByText('Approved · invite sent')).toBeVisible()
      await ownerContext.close()

      const invite = await fetchLatestEmailBody(visitor)
      expect(invite).toMatch(/Your place at The Last Ten is ready|Create your account here/)
      const inviteLink = invite.match(/https?:\/\/\S+\/login\?email=\S+/)?.[0]
      expect(inviteLink, 'the invite links to sign-in').toBeTruthy()

      // ---- 4. The visitor follows the invite: the address is filled in, the link comes, they are in.
      await page.goto(inviteLink!)
      await expect(page.getByLabel('Email address')).toHaveValue(visitor)
      await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
      await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
      const signIn = await nextSignInLink(visitor)
      // Issue #98 (VT-E5): Supabase sends the sign-in link in our design too.
      const signInHtml = await fetchLatestEmailBody(visitor, 20_000, 'html')
      const button = signInHtml.match(/<a href="([^"]+)"[^>]*display:inline-block;padding/)?.[1]
      expect(button?.replace(/&amp;/g, '&'), 'the designed button carries the sign-in link').toBe(signIn)
      expect(signInHtml).toContain('Ten minutes. Together.')
      await page.goto(signIn)
      await expect(page).toHaveURL(/\/dashboard$/)
      await expect(page.getByRole('heading', { name: 'My family' })).toBeVisible()
      expect(await accountExists(visitor)).toBe(true)
    } finally {
      await deleteTestUser(visitor)
    }
  })

  test('an address nobody confirms never reaches the owner’s list (VT-W13)', async ({ page, browser }) => {
    const unconfirmed = uniqueEmail('waitlist-unconfirmed')
    const confirmed = uniqueEmail('waitlist-confirmed')
    try {
      for (const email of [unconfirmed, confirmed]) {
        await page.goto('/')
        await page.getByLabel('Email for the waitlist').fill(email)
        await page.getByRole('button', { name: 'Join the waitlist' }).click()
        await expect(page.getByText('Check your email.')).toBeVisible()
      }
      await page.goto(await confirmLink(confirmed))
      await page.getByRole('button', { name: 'Confirm my place' }).click()
      await expect(page.getByRole('heading', { name: 'You’re on the list.' })).toBeVisible()

      const ownerContext = await browser.newContext()
      const owner = await ownerContext.newPage()
      await signInWithMagicLink(owner, E2E_OWNER_EMAIL, { approve: false })
      await owner.goto('/admin/waitlist')
      await expect(owner.getByRole('button', { name: `Approve: ${confirmed}` })).toBeVisible()
      await expect(owner.getByText(unconfirmed)).toHaveCount(0)
      await expect(owner.getByText(/not confirmed yet/)).toBeVisible()
      await ownerContext.close()
    } finally {
      await deleteTestUser(unconfirmed)
      await deleteTestUser(confirmed)
    }
  })

  test('joining from the sign-in page asks for the email confirmation too', async ({ page }) => {
    const visitor = uniqueEmail('waitlist-login')
    try {
      await page.goto('/login')
      await page.getByLabel('Email address').fill(visitor)
      await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
      await page.getByRole('button', { name: 'Join the waitlist' }).click()
      await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible()
      await expect(page.getByText(/on the list/)).toHaveCount(0)
      expect(await confirmLink(visitor)).toMatch(/\/waitlist\/confirm\?token=/)
    } finally {
      await deleteTestUser(visitor)
    }
  })

  test('a confirm link with no token, or a made-up one, says so', async ({ page }) => {
    await page.goto('/waitlist/confirm')
    await expect(page.getByRole('heading', { name: /expired or was already used/ })).toBeVisible()
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto(`/waitlist/confirm?token=${'A'.repeat(43)}`)
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, 'no horizontal scroll at 375px').toBeLessThanOrEqual(0)
    await page.getByRole('button', { name: 'Confirm my place' }).click()
    await expect(page.getByRole('heading', { name: /expired or was already used/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /Join the waitlist/ })).toHaveAttribute('href', '/#join')
  })

  test('/admin/waitlist is a 404 to a parent', async ({ page }) => {
    const parent = uniqueEmail('waitlist-parent')
    try {
      await signInWithMagicLink(page, parent)
      const response = await page.goto('/admin/waitlist')
      expect(response?.status()).toBe(404)
      const api = await page.request.post('/api/admin/waitlist', { data: { email: parent } })
      expect(api.status()).toBe(404)
    } finally {
      await deleteTestUser(parent)
    }
  })
})
