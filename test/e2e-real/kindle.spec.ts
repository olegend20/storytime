import { expect, test } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { deleteTestUser, localAuthStackReachable, signInWithMagicLink, SKIP_REASON, uniqueEmail } from '../e2e/support/login'

/**
 * Send to Kindle (issue #11), end to end through the real app: save the address in
 * Settings, open a saved story, press Send to Kindle, and find the email - with its EPUB
 * attachment - in the local mailbox, which plays the email provider.
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const MAILBOX = process.env.SUPABASE_MAILBOX_URL ?? 'http://127.0.0.1:54324'
const LOCAL_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const service = () =>
  createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_SERVICE_KEY, { auth: { persistSession: false } })

function savedStory(title: string) {
  return {
    title,
    subtitle: null,
    chapters: Array.from({ length: 6 }, (_, i) => ({
      heading: `Chapter ${i + 1}: Brick ${i + 1}`,
      text: `Milo picked up brick number ${i + 1}. It clicked into place.`,
      shout_line: i === 0 ? 'CLICK!' : null,
    })),
    ending_line: 'Goodnight, Milo.',
    true_facts: Array.from({ length: 8 }, (_, i) => ({ text: `True fact ${i + 1}.`, fact_id: `f${i + 1}` })),
    bible_suggestions: { new_recurring: [], ending_summary: 'The tower stood.' },
    estimated_read_minutes: 5,
  }
}

async function latestMailTo(address: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${MAILBOX}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)
    const found = (await res.json()) as { messages?: { ID: string }[] }
    const id = found.messages?.[0]?.ID
    if (id) {
      const detail = await fetch(`${MAILBOX}/api/v1/message/${id}`)
      return (await detail.json()) as {
        Subject: string
        From: { Address: string }
        Attachments?: { FileName: string; ContentType: string; Size: number }[]
      }
    }
    if (Date.now() > deadline) throw new Error(`no mail to ${address}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

test.describe('Send to Kindle', () => {
  test.beforeEach(async () => {
    test.skip(!(await localAuthStackReachable()), SKIP_REASON)
  })

  test('settings, then a saved story lands in the (local) Kindle mailbox as an EPUB', async ({ page }) => {
    const email = uniqueEmail('kindle')
    const kindle = `milo_${Date.now().toString(36)}@kindle.com`
    try {
      await signInWithMagicLink(page, email)

      // A story to send, and a child for the title page.
      const db = service()
      const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 })
      const userId = users.users.find((u) => u.email === email)!.id
      const { data: family } = await db.from('families').select('id').eq('owner_user_id', userId).single()
      const { data: child } = await db.from('children').insert({ family_id: family!.id, first_name: 'Milo', age: 7 }).select('id').single()
      const { data: series } = await db
        .from('series')
        .insert({ family_id: family!.id, child_ids: [child!.id], child_key: child!.id })
        .select('id')
        .single()
      const { data: story } = await db
        .from('stories')
        .insert({
          family_id: family!.id,
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

      // Without an address: the button explains and links to Settings.
      await page.goto(`/stories/${story!.id}`)
      await page.getByTestId('send-to-kindle').click()
      await expect(page.getByTestId('kindle-error')).toContainText('Add your Kindle address')
      await page.getByRole('link', { name: 'Add it in Settings' }).click()
      await expect(page).toHaveURL(/\/settings$/)

      // Settings: our sending address is shown, the Kindle address is saved.
      await expect(page.getByTestId('kindle-from')).toHaveText('kindle@storytime.local')
      await page.getByLabel('Send-to-Kindle address').fill('milo@gmail.com')
      await page.getByRole('button', { name: 'Save Kindle address' }).click()
      const kindleForm = page.locator('form[aria-labelledby="kindle-heading"]')
      await expect(kindleForm.getByRole('alert')).toContainText('@kindle.com')
      await page.getByLabel('Send-to-Kindle address').fill(kindle)
      await page.getByRole('button', { name: 'Save Kindle address' }).click()
      await expect(page.getByText('Saved.')).toBeVisible()

      // Send.
      await page.goto(`/stories/${story!.id}`)
      await page.getByTestId('send-to-kindle').click()
      await expect(page.getByTestId('kindle-sent')).toContainText(`Sent to ${kindle}`)

      const mail = await latestMailTo(kindle)
      expect(mail.Subject).toBe('Milo and the Tower That Clicked')
      expect(mail.From.Address).toBe('kindle@storytime.local')
      const epub = (mail.Attachments ?? []).find((a) => a.FileName.endsWith('.epub'))
      expect(epub, JSON.stringify(mail.Attachments)).toBeDefined()
      expect(epub!.FileName).toBe('Milo-and-the-Tower-That-Clicked.epub')
      expect(epub!.ContentType).toContain('epub')
      expect(epub!.Size).toBeGreaterThan(1_000)

      const { data: sends } = await db.from('story_sends').select('to_address').eq('family_id', family!.id)
      expect(sends).toEqual([{ to_address: kindle }])
    } finally {
      await deleteTestUser(email)
    }
  })
})
