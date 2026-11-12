import { expect, test, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  approveEmail,
  deleteTestUser,
  extractSignInLink,
  fetchLatestEmailBody,
  localAuthStackReachable,
  onTestServer,
  SKIP_REASON,
  uniqueEmail,
} from '../e2e/support/login'

/**
 * F2, as the owner reported it: "I click the sign-in link from the local mailbox but end up
 * in a loop where I have to sign in again."
 *
 * The link sent `redirect_to` a URL Supabase did not allow-list (`localhost`, or any
 * `?next=`), so Supabase silently fell back to the bare home page and nothing completed the
 * sign-in. The old e2e helper never saw it: it signed in on the one exact allow-listed URL,
 * and on any other port it REWROTE the link before opening it.
 *
 * So these tests open the link exactly as it arrives in the mailbox, on `localhost`, and
 * define done the owner's way: signed in, with the saved children and stories still there,
 * and able to sign out and back in with the same email.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const LOCAL_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const service = () =>
  createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_SERVICE_KEY, {
    auth: { persistSession: false },
  })

const origin = (page: Page) => new URL(page.url()).origin

/** Request a link from the login page and return it exactly as the email carries it. */
async function requestLink(page: Page, email: string, previous: string | null): Promise<string> {
  await page.getByLabel('Email address').fill(email)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  // Wait for a NEW message: the second sign-in must not reuse the first link.
  const deadline = Date.now() + 20_000
  for (;;) {
    const link = extractSignInLink(await fetchLatestEmailBody(email))
    if (link !== previous) return link
    if (Date.now() > deadline) throw new Error('no new sign-in email arrived')
    await page.waitForTimeout(500)
  }
}

test.describe('F2: the magic link, opened exactly as it arrives', () => {
  test.beforeEach(async () => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
  })

  test('sign in, keep children and stories, sign out, sign back in with the same email', async ({
    page,
  }) => {
    const email = uniqueEmail('owner-loop')
    await approveEmail(email) // issue #92: a new parent is one the owner let in
    try {
      // ---- 1. First sign-in, from the landing page's "Sign in".
      await page.goto('/')
      await page.getByRole('link', { name: 'Sign in', exact: true }).click()
      const first = await requestLink(page, email, null)
      // Issue #101 (VT-L3): the link is on the site itself - site_url, which is the dev
      // server locally and lastten.org in production - and /auth/link hands it to Supabase.
      const url = new URL(first)
      expect(url.origin).toBe('http://localhost:3000')
      expect(url.pathname).toBe('/auth/link')
      expect(url.searchParams.get('token_hash')).toMatch(/^[\w-]{20,}/)
      expect(url.searchParams.get('type')).toMatch(/^(magiclink|signup)$/)
      await page.goto(onTestServer(first, origin(page)))
      await expect(page).toHaveURL(/localhost:\d+\/dashboard$/)
      await expect(page.getByRole('heading', { name: 'My family' })).toBeVisible()

      // ---- 2. Things to come back to: a child, and a saved story.
      await page.goto('/children')
      await page.getByLabel('First name').fill('Milo')
      await page.getByLabel('Age').fill('7')
      await page.getByRole('button', { name: 'Add child' }).click()
      await expect(page.getByTestId('child-row')).toHaveCount(1)

      const db = service()
      const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 })
      const userId = users.users.find((u) => u.email === email)!.id
      const { data: family } = await db.from('families').select('id').eq('owner_user_id', userId).single()
      const { data: child } = await db.from('children').select('id').eq('family_id', family!.id).single()
      const { data: series } = await db
        .from('series')
        .insert({ family_id: family!.id, child_ids: [child!.id], child_key: child!.id })
        .select('id')
        .single()
      const { error: storyErr } = await db.from('stories').insert({
        family_id: family!.id,
        series_id: series!.id,
        topic_input: 'sharks',
        topic_key: 'sharks',
        tones: ['funny'],
        length_minutes: 5,
        age_band: 'B',
        title: 'Milo and the Singing Shark',
        content: {
          title: 'Milo and the Singing Shark',
          subtitle: null,
          chapters: Array.from({ length: 6 }, (_, i) => ({
            heading: `Chapter ${i + 1}`,
            text: `Milo swam a little further, chapter ${i + 1}.`,
            shout_line: null,
          })),
          ending_line: 'And the shark sang Milo to sleep.',
          true_facts: Array.from({ length: 8 }, (_, i) => ({ text: `Shark fact ${i + 1}.`, fact_id: `f${i + 1}` })),
          bible_suggestions: { new_recurring: [], ending_summary: 'The shark sang.' },
          estimated_read_minutes: 5,
        },
        word_count: 600,
        status: 'ready',
      })
      expect(storyErr).toBeNull()

      // ---- 3. Sign out: the family pages lock again.
      await page.goto('/settings')
      await page.getByRole('button', { name: 'Sign out' }).click()
      await expect(page).toHaveURL(/localhost:\d+\/$/)
      await page.goto('/dashboard')
      await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/)

      // ---- 4. Sign back in with the same email - from a protected page, so the link carries
      //         `?next=`, the case that also looped.
      const second = await requestLink(page, email, first)
      await page.goto(onTestServer(second, origin(page)))
      await expect(page).toHaveURL(/localhost:\d+\/dashboard$/)

      // Same family, same child, same story.
      await page.goto('/children')
      await expect(page.getByTestId('child-row')).toHaveCount(1)
      await expect(page.getByTestId('child-row')).toContainText('Milo')
      await page.goto('/library')
      await expect(page.getByRole('link').filter({ hasText: 'Milo and the Singing Shark' })).toBeVisible()

      // And still exactly one family for this account (F2 AC: login never duplicates it).
      const { count } = await db
        .from('families')
        .select('id', { count: 'exact', head: true })
        .eq('owner_user_id', userId)
      expect(count).toBe(1)
    } finally {
      await deleteTestUser(email)
    }
  })

  test('an email sent before #101 (Supabase verify link, landing on the home page) still signs you in', async ({ page }) => {
    // Links already in inboxes when the template changed go through Supabase's /verify and
    // come back with `?code=`; when the redirect is not recognised Supabase falls back to the
    // site root, and the proxy forwards that to the callback.
    const email = uniqueEmail('owner-root')
    await approveEmail(email)
    try {
      await page.goto('/login')
      const link = new URL(await requestLink(page, email, null))
      const verify = new URL(`${SUPABASE_URL}/auth/v1/verify`)
      verify.searchParams.set('token', link.searchParams.get('token_hash')!)
      verify.searchParams.set('type', 'magiclink')
      verify.searchParams.set('redirect_to', `${origin(page)}/`)
      await page.goto(verify.toString())
      await expect(page).toHaveURL(/localhost:\d+\/dashboard$/)
    } finally {
      await deleteTestUser(email)
    }
  })

  test('the link only signs in the browser that asked for it (VT-L4, owner decision)', async ({
    page,
    browser,
  }) => {
    // DECISIONS #219: a forwarded email, or a scanner that opens links, must not sign anyone in.
    const email = uniqueEmail('cross-device')
    await approveEmail(email)
    const phone = await browser.newContext()
    try {
      await page.goto('/login')
      const link = await requestLink(page, email, null)
      const other = await phone.newPage()
      await other.goto(onTestServer(link, origin(page)))
      await expect(other).toHaveURL(/\/login\?error=/)
      await expect(other.getByText(/Open it on the device and browser you asked from/)).toBeVisible()
      await other.goto('/dashboard')
      await expect(other).toHaveURL(/\/login\?next=/)
    } finally {
      await phone.close()
      await deleteTestUser(email)
    }
  })

  test('signing in from a page brings you back to it (VT-L5)', async ({ page }) => {
    const email = uniqueEmail('next-page')
    await approveEmail(email)
    try {
      await page.goto('/library')
      await expect(page).toHaveURL(/\/login\?next=%2Flibrary/)
      const link = await requestLink(page, email, null)
      expect(link, 'the page is not in the emailed link').not.toContain('library')
      await page.goto(onTestServer(link, origin(page)))
      await expect(page).toHaveURL(/\/library$/)
      // The remembered page is used once: the next sign-in, from /login, goes to the dashboard.
      const cookies = await page.context().cookies()
      expect(cookies.find((c) => c.name === 'st_next')).toBeUndefined()
    } finally {
      await deleteTestUser(email)
    }
  })

  test('a used or altered link is refused and says so (VT-L6)', async ({ page }) => {
    // In the browser that asked, so only the link itself can be at fault.
    const email = uniqueEmail('reuse')
    const second = uniqueEmail('altered')
    await approveEmail(email)
    try {
      await page.goto('/login')
      const link = onTestServer(await requestLink(page, email, null), origin(page))
      await page.goto(link)
      await expect(page).toHaveURL(/\/dashboard$/)
      await page.goto('/settings')
      await page.getByRole('button', { name: 'Sign out' }).click()

      await page.goto(link) // used
      await expect(page).toHaveURL(/\/login/)
      await expect(page.getByText(/expired or was already used|did not work/)).toBeVisible()
      await page.goto('/dashboard')
      await expect(page).toHaveURL(/\/login\?next=/)

      // A second address: Supabase allows one link a minute per address.
      await approveEmail(second)
      await page.goto('/login')
      const fresh = onTestServer(await requestLink(page, second, null), origin(page))
      const altered = fresh.replace(/token_hash=([^&]*)/, (_, t: string) => `token_hash=${t.slice(0, -1)}${t.endsWith('a') ? 'b' : 'a'}`)
      expect(altered).not.toBe(fresh)
      await page.goto(altered)
      await expect(page).toHaveURL(/\/login/)
      await expect(page.getByText(/expired or was already used|did not work/)).toBeVisible()
      await page.goto('/dashboard')
      await expect(page).toHaveURL(/\/login\?next=/)
    } finally {
      await deleteTestUser(second)
      await deleteTestUser(email)
    }
  })
})
