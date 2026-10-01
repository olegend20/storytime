import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { ensureFamily, updateFamily, FamilySettingsInput } from '@/lib/family/service'
import { handleUpdateFamily } from '@/lib/family/handlers'
import { KINDLE_SENDS_PER_DAY, KindleSendError, sendStoryToKindle, type OutgoingMail } from '@/lib/kindle/send'
import { getLibraryStory } from '@/lib/stories/library'
import { usageDateFor } from '@/lib/limits/timezone'
import { stubStory } from '../helpers/fixtures'
import {
  cleanupUser,
  createTestUser,
  localDbAvailable,
  serviceClient,
  SKIP_REASON,
  type TestUser,
} from './support/lane1-db'

/** Send to Kindle (issue #11): settings, the send, its limits, and who can see what. */

const dbUp = await localDbAvailable()
if (!dbUp) console.warn(`[kindle int] skipped: ${SKIP_REASON}`)

describe.runIf(dbUp)('Send to Kindle', () => {
  let parent: TestUser
  let stranger: TestUser
  let familyId: string
  let storyId: string
  // One timezone and one fixed moment for every send in this file. The daily limit is counted
  // per calendar day in the family's zone, so mixing zones or using the real clock made this
  // suite fail for the hour each night when London is already on tomorrow's date (23:00 UTC).
  const TZ = 'Europe/London'
  const NOW = new Date('2026-06-15T12:00:00Z')
  const DAY_MS = 24 * 60 * 60 * 1000
  const outbox: OutgoingMail[] = []
  const sender = { send: async (m: OutgoingMail) => void outbox.push(m) }

  beforeAll(async () => {
    parent = await createTestUser('kindle')
    stranger = await createTestUser('kindle-stranger')
    familyId = (await ensureFamily(parent.client, parent.userId)).id
    await ensureFamily(stranger.client, stranger.userId)
    const db = serviceClient()
    const { data: child } = await db.from('children').insert({ family_id: familyId, first_name: 'Milo', age: 7 }).select('id').single()
    const { data: series } = await db
      .from('series')
      .insert({ family_id: familyId, child_ids: [child!.id], child_key: child!.id })
      .select('id')
      .single()
    const { data: story } = await db
      .from('stories')
      .insert({
        family_id: familyId,
        series_id: series!.id,
        topic_input: 'the history of LEGO',
        topic_key: 'history-of-lego',
        tones: ['funny'],
        length_minutes: 10,
        age_band: 'B',
        title: 'Milo and the Tower That Clicked',
        content: stubStory(),
        word_count: 1500,
        status: 'ready',
      })
      .select('id')
      .single()
    storyId = story!.id as string
  })

  afterAll(async () => {
    await serviceClient().from('story_sends').delete().eq('family_id', familyId)
    await cleanupUser(parent)
    await cleanupUser(stranger)
  })

  it('saves a Kindle address through the settings handler, normalised; refuses anything else', async () => {
    const ok = await handleUpdateFamily(
      { db: parent.client, family: { id: familyId } as never },
      { kindle_email: '  Milo_ABC@Kindle.com ' },
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { family: { kindle_email: string | null } }
    expect(body.family.kindle_email).toBe('milo_abc@kindle.com')

    const bad = await handleUpdateFamily({ db: parent.client, family: { id: familyId } as never }, { kindle_email: 'milo@gmail.com' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { message: string }).message).toMatch(/@kindle\.com/)

    const html = await handleUpdateFamily({ db: parent.client, family: { id: familyId } as never }, { kindle_email: '<b>x</b>@kindle.com' })
    expect(html.status).toBe(400)
  })

  it('another family cannot read the address (RLS)', async () => {
    const { data } = await stranger.client.from('families').select('kindle_email').eq('id', familyId)
    expect(data).toEqual([])
  })

  it('refuses to send without an address, and without mail set up', async () => {
    const story = (await getLibraryStory(parent.client, storyId))!
    const base = { familyId, story: { id: story.id, title: story.title, content: story.content }, childNames: ['Milo'], db: serviceClient() }
    await expect(sendStoryToKindle({ ...base, kindleEmail: null, sender, from: 'kindle@storytime.local' })).rejects.toMatchObject({ code: 'no_kindle_address' })
    await expect(sendStoryToKindle({ ...base, kindleEmail: 'milo_abc@kindle.com', sender: null, from: null })).rejects.toMatchObject({ code: 'not_configured' })
    expect(outbox).toHaveLength(0)
  })

  it('sends the story as an EPUB attachment to the Kindle address, and logs the send', async () => {
    const story = (await getLibraryStory(parent.client, storyId))!
    const result = await sendStoryToKindle({
      familyId,
      kindleEmail: 'milo_abc@kindle.com',
      story: { id: story.id, title: story.title, content: story.content },
      childNames: ['Milo'],
      sender,
      from: 'kindle@storytime.local',
      db: serviceClient(),
      timezone: TZ,
      now: NOW,
    })
    expect(result.to).toBe('milo_abc@kindle.com')
    expect(result.sentToday).toBe(1)
    expect(outbox).toHaveLength(1)
    const mail = outbox[0]!
    expect(mail.to).toBe('milo_abc@kindle.com')
    expect(mail.from).toBe('kindle@storytime.local')
    expect(mail.subject).toBe('Milo and the Tower That Clicked')
    expect(mail.attachment.filename).toBe('Milo-and-the-Tower-That-Clicked.epub')
    expect(mail.attachment.contentType).toBe('application/epub+zip')
    const zip = await JSZip.loadAsync(mail.attachment.content)
    expect(await zip.file('OEBPS/package.opf')!.async('string')).toContain('Milo and the Tower That Clicked')

    const { data: sends } = await serviceClient().from('story_sends').select('to_address, story_id').eq('family_id', familyId)
    expect(sends).toEqual([{ to_address: 'milo_abc@kindle.com', story_id: storyId }])
  })

  it('stops at the daily limit, and a failed delivery is reported as such with nothing logged', async () => {
    const story = (await getLibraryStory(parent.client, storyId))!
    const base = {
      familyId,
      kindleEmail: 'milo_abc@kindle.com',
      story: { id: story.id, title: story.title, content: story.content },
      childNames: ['Milo'],
      from: 'kindle@storytime.local',
      db: serviceClient(),
      timezone: TZ,
      now: NOW,
    }
    const broken = { send: async () => { throw new Error('smtp down') } }
    await expect(sendStoryToKindle({ ...base, sender: broken })).rejects.toMatchObject({ code: 'delivery_failed' })

    // The failed send gave its slot back: still exactly the one logged row.
    const { count: afterFailure } = await serviceClient().from('story_sends').select('id', { count: 'exact', head: true }).eq('family_id', familyId)
    expect(afterFailure).toBe(1)

    const today = usageDateFor(TZ, NOW)
    const rows = Array.from({ length: KINDLE_SENDS_PER_DAY - 1 }, () => ({ family_id: familyId, story_id: storyId, to_address: 'milo_abc@kindle.com', usage_date: today }))
    await serviceClient().from('story_sends').insert(rows)
    const err = await sendStoryToKindle({ ...base, sender }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KindleSendError)
    expect((err as KindleSendError).code).toBe('daily_limit')
    expect(outbox).toHaveLength(1) // nothing more was sent
    const { count: afterLimit } = await serviceClient().from('story_sends').select('id', { count: 'exact', head: true }).eq('family_id', familyId)
    expect(afterLimit).toBe(KINDLE_SENDS_PER_DAY) // the refused send gave its slot back too

    // A different calendar day for the family is a fresh allowance.
    const tomorrow = usageDateFor(TZ, new Date(NOW.getTime() + DAY_MS))
    const next = await sendStoryToKindle({ ...base, sender, now: new Date(NOW.getTime() + DAY_MS) })
    expect(next.sentToday).toBe(1)
    const { data: fresh } = await serviceClient().from('story_sends').select('usage_date').eq('family_id', familyId).eq('usage_date', tomorrow)
    expect(fresh).toHaveLength(1)
  })

  it('an empty string clears the address', async () => {
    const parsed = FamilySettingsInput.safeParse({ kindle_email: '' })
    expect(parsed.success).toBe(true)
    const family = await updateFamily(serviceClient(), familyId, { kindle_email: '' })
    expect(family.kindle_email).toBeNull()
  })
})
