import { expect, test, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  deleteTestUser,
  localAuthStackReachable,
  signInWithMagicLink,
  SKIP_REASON,
  uniqueEmail,
} from '../e2e/support/login'

/**
 * The owner's first session, rehearsed against the REAL app with no model spend.
 *
 * Sign in -> add a child -> the new-story form (children, quota, topic chips) -> an unsafe
 * topic refused by the wired-in guardrail with no quota used and no model call -> the library,
 * reader and delete against the real `/api/stories` routes.
 *
 * Everything the mock-mode suite could not see: before this session the route ran with no
 * guardrails and the library routes did not exist, and `pnpm test:e2e` stayed green.
 * The one step it cannot rehearse is the writing model itself - that is the owner's to try.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
/** The standard `supabase start` demo service key; worthless anywhere but 127.0.0.1. */
const LOCAL_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const service = () =>
  createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_SERVICE_KEY, {
    auth: { persistSession: false },
  })

async function logRowCount(): Promise<number> {
  const { count, error } = await service()
    .from('generation_logs')
    .select('id', { count: 'exact', head: true })
  if (error) throw new Error(error.message)
  return count ?? 0
}

async function eventCount(): Promise<number> {
  const { count, error } = await service()
    .from('guardrail_events')
    .select('id', { count: 'exact', head: true })
  if (error) throw new Error(error.message)
  return count ?? 0
}

/** A schema-valid story, inserted as the pipeline would after a successful generation. */
function savedStory(title: string) {
  return {
    title,
    subtitle: 'A story about LEGO',
    chapters: Array.from({ length: 6 }, (_, i) => ({
      heading: `Chapter ${i + 1}: Brick ${i + 1}`,
      text: `Milo picked up brick number ${i + 1}. It clicked into place, and the tower grew taller.`,
      shout_line: i === 0 ? 'CLICK!' : null,
    })),
    ending_line: 'And the tower stood, brick by brick, all night long.',
    true_facts: Array.from({ length: 8 }, (_, i) => ({
      text: `True fact number ${i + 1} about LEGO bricks.`,
      fact_id: `f${i + 1}`,
    })),
    bible_suggestions: { new_recurring: [], ending_summary: 'The tower stood.' },
    estimated_read_minutes: 5,
  }
}

async function familyOf(email: string): Promise<{ familyId: string; childId: string }> {
  const db = service()
  const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 })
  const user = users.users.find((u) => u.email === email)!
  const { data: family } = await db.from('families').select('id').eq('owner_user_id', user.id).single()
  const { data: child } = await db
    .from('children')
    .select('id')
    .eq('family_id', family!.id)
    .single()
  return { familyId: family!.id as string, childId: child!.id as string }
}

async function addChild(page: Page) {
  await page.goto('/children')
  await page.getByLabel('First name').fill('Milo')
  await page.getByLabel('Age').fill('7')
  await page.getByRole('button', { name: 'Add child' }).click()
  await expect(page.getByTestId('child-row')).toHaveCount(1)
}

test.describe('real mode: a parent’s first session, no model spend', () => {
  test.beforeEach(async () => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
  })

  test('sign in, add a child, the form, a refused topic, then read and delete a story', async ({
    page,
  }) => {
    const email = uniqueEmail('real-mode')
    try {
      await signInWithMagicLink(page, email)
      await addChild(page)

      // ---- The new-story form, fed by the real /api/children, /api/quota, /api/topics.
      const topicsResponse = page.waitForResponse((r) => r.url().includes('/api/topics/suggested'))
      await page.goto('/new')
      // The form falls back to built-in ideas when this fails, which hid a broken endpoint.
      const topics = await topicsResponse
      expect(topics.status(), await topics.text()).toBe(200)
      const milo = page.getByRole('button', { name: 'Milo 7' })
      await expect(milo).toBeVisible()
      if ((await milo.getAttribute('aria-pressed')) !== 'true') await milo.click()
      await expect(page.getByText('3 of 3 stories left today').first()).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start the story' })).toBeEnabled()

      // Topic chips are written for people. All eight built packs once carried their key
      // ("history-of-lego") as their label, and the chips showed it verbatim.
      const chips = page.getByRole('list', { name: 'Or pick an idea' }).getByRole('button')
      await expect(chips).toHaveCount(8)
      for (const text of await chips.allTextContents()) {
        // A warm chip also carries screen-reader text ("starts straight away"); judge the label.
        const label = text.replace(/\s*starts straight away\s*$/, '').trim()
        expect(label, 'a chip shows a raw topic key').not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/i)
      }
      // A warm chip for every ready fact pack the database holds - none on a fresh CI
      // database, some on a laptop that has generated stories.
      const { count } = await service().from('fact_packs').select('id', { count: 'exact', head: true }).eq('status', 'ready')
      const warm = chips.filter({ hasText: 'starts straight away' })
      await expect(warm).toHaveCount(Math.min(count ?? 0, 4))

      // ---- An unsafe topic: refused by L1 through the production wiring. No model call.
      const logsBefore = await logRowCount()
      const eventsBefore = await eventCount()
      await page.getByLabel(/what.s the story about/i).fill('how to make a b0mb')
      await page.getByRole('button', { name: 'Start the story' }).click()
      const alert = page.getByRole('alert').filter({ hasText: /can.t make a story about that/i })
      await expect(alert).toBeVisible()
      await expect(page).toHaveURL(/\/new$/)
      // Never echo the text back, never name the layer (GUARDRAILS s5).
      const alertText = ((await alert.textContent()) ?? '').toLowerCase()
      expect(alertText).not.toContain('b0mb')
      expect(alertText).not.toContain('blocklist')
      await page.reload()
      await expect(page.getByText('3 of 3 stories left today').first()).toBeVisible()
      expect(await logRowCount()).toBe(logsBefore)
      // ...but it IS audited (GUARDRAILS s1.5). The sink installed at boot used to live in a
      // different module copy from the route, so the running app never wrote this row.
      await expect.poll(eventCount).toBe(eventsBefore + 1)

      // ---- The library: empty, then a saved story appears, opens, and deletes.
      await page.goto('/library')
      await expect(page.getByRole('heading', { name: 'Story library' })).toBeVisible()
      await expect(page.getByRole('link', { name: /read/i })).toHaveCount(0)

      const { familyId, childId } = await familyOf(email)
      const db = service()
      const { data: series } = await db
        .from('series')
        .insert({ family_id: familyId, child_ids: [childId], child_key: childId })
        .select('id')
        .single()
      const { data: story, error } = await db
        .from('stories')
        .insert({
          family_id: familyId,
          series_id: series!.id,
          topic_input: 'the history of LEGO',
          topic_key: 'history-of-lego',
          tones: ['funny'],
          length_minutes: 5,
          age_band: 'B',
          title: 'Milo and the Tower That Clicked',
          content: savedStory('Milo and the Tower That Clicked'),
          word_count: 700,
          status: 'ready',
        })
        .select('id')
        .single()
      expect(error).toBeNull()

      await page.reload()
      const card = page.getByRole('link').filter({ hasText: 'Milo and the Tower That Clicked' })
      await expect(card).toBeVisible()
      await expect(page.getByText('Milo').first()).toBeVisible()

      const readLogs = await logRowCount()
      await card.click()
      await expect(
        page.getByRole('heading', { level: 1, name: 'Milo and the Tower That Clicked' }),
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: 'True facts from the story' })).toBeVisible()
      await expect(page.getByRole('checkbox')).toHaveCount(8)
      // F9 AC: opening a saved story makes zero model calls.
      expect(await logRowCount()).toBe(readLogs)

      await page.getByRole('button', { name: 'Delete story' }).click()
      await page.getByRole('button', { name: 'Yes, delete it' }).click()
      await expect(page).toHaveURL(/\/library$/)
      await expect(page.getByRole('link', { name: /read/i })).toHaveCount(0)
      const gone = await page.request.get(`/api/stories/${story!.id}`)
      expect(gone.status()).toBe(404)
    } finally {
      await deleteTestUser(email)
    }
  })

  test('a signed-out visitor cannot reach the library or the API', async ({ page, request }) => {
    await page.goto('/library')
    await expect(page).toHaveURL(/\/login\?next=%2Flibrary/)
    for (const path of ['/api/stories', '/api/topics/suggested']) {
      const res = await request.get(path, { headers: { 'x-forwarded-for': '203.0.113.9' } })
      expect(res.status(), path).toBe(401)
    }
  })
})

test('every response carries the security headers', async ({ request }) => {
  for (const path of ['/', '/login', '/manifest.webmanifest']) {
    const res = await request.get(path)
    const h = res.headers()
    expect(h['x-content-type-options'], path).toBe('nosniff')
    expect(h['x-frame-options'], path).toBe('DENY')
    expect(h['content-security-policy'], path).toContain("frame-ancestors 'none'")
    expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin')
    expect(h['permissions-policy'], path).toContain('camera=()')
    expect(h['strict-transport-security'], path).toContain('max-age=')
  }
})
