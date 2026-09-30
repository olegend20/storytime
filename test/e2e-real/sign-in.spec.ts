import { expect, test, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  deleteTestUser,
  extractSignInLink,
  fetchLatestEmailBody,
  localAuthStackReachable,
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
    try {
      // ---- 1. First sign-in, from the landing page's "Sign in".
      await page.goto('/')
      await page.getByRole('link', { name: 'Sign in' }).click()
      const first = await requestLink(page, email, null)
      // The bug itself: Supabase rewrote this to the bare site root.
      expect(new URL(first).searchParams.get('redirect_to')).toMatch(
        /^http:\/\/localhost:\d+\/auth\/callback/,
      )
      await page.goto(first) // unmodified
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
      await page.goto(second) // unmodified
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

  test('a link that lands on the home page still signs you in', async ({ page }) => {
    // Belt and braces for any redirect Supabase does not recognise: it falls back to the
    // site root with `?code=`, and the proxy forwards that to the callback.
    const email = uniqueEmail('owner-root')
    try {
      await page.goto('/login')
      const link = await requestLink(page, email, null)
      const verify = new URL(link)
      verify.searchParams.set('redirect_to', `${new URL(page.url()).origin}/`)
      await page.goto(verify.toString())
      await expect(page).toHaveURL(/localhost:\d+\/dashboard$/)
    } finally {
      await deleteTestUser(email)
    }
  })
})
