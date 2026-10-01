import type { SupabaseClient } from '@supabase/supabase-js'
import nodemailer, { type Transporter } from 'nodemailer'
import { serverEnv } from '@/lib/env'
import { supabaseService } from '@/lib/supabase/service'
import type { StoryOutput } from '@/lib/schemas'
import { safeTimeZone, usageDateFor } from '@/lib/limits/timezone'
import { isKindleAddress, normalizeKindleAddress } from './address'
import { buildEpub, epubFilename, EPUB_MIME } from './epub'

/**
 * Send a story to a Kindle (issue #11, DECISIONS #150): build the EPUB, mail it to the
 * parent's Send-to-Kindle address, log the send. No model call, no cost to us beyond the
 * email provider's.
 *
 * `MailSender` is the seam: production uses SMTP (any provider); tests inject a recorder;
 * local development points SMTP at the Supabase mailbox.
 */

export interface OutgoingMail {
  to: string
  from: string
  subject: string
  text: string
  attachment: { filename: string; content: Buffer; contentType: string }
}

export interface MailSender {
  send(mail: OutgoingMail): Promise<void>
}

/** A family may send this many stories a day. Plenty for bedtime; a brake on abuse. */
export const KINDLE_SENDS_PER_DAY = 20

export type KindleSendFailure =
  | 'not_configured'
  | 'no_kindle_address'
  | 'daily_limit'
  | 'delivery_failed'

export class KindleSendError extends Error {
  constructor(readonly code: KindleSendFailure, message: string) {
    super(message)
    this.name = 'KindleSendError'
  }
}

/** Both halves, or the feature is off: the one answer Settings and the send path share. */
export function kindleConfigured(): boolean {
  const env = serverEnv()
  return Boolean(env.SMTP_HOST && env.KINDLE_FROM_EMAIL)
}

let transport: Transporter | null = null

/** The configured SMTP transport (one, pooled, like the Supabase client), or null. */
export function smtpSender(): MailSender | null {
  const env = serverEnv()
  if (!kindleConfigured()) return null
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    pool: true,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
  })
  const t = transport
  return {
    async send(mail) {
      await t.sendMail({
        to: mail.to,
        from: mail.from,
        subject: mail.subject,
        text: mail.text,
        attachments: [
          { filename: mail.attachment.filename, content: mail.attachment.content, contentType: mail.attachment.contentType },
        ],
      })
    },
  }
}

/** Our sending address - null unless the whole feature is configured. */
export function kindleFromAddress(): string | null {
  return kindleConfigured() ? (serverEnv().KINDLE_FROM_EMAIL ?? null) : null
}

export interface SendStoryInput {
  familyId: string
  /** The parent's saved address; null when none is set. */
  kindleEmail: string | null
  story: { id: string; title: string; content: StoryOutput }
  childNames: readonly string[]
  /** The family's IANA zone: the daily limit is their calendar day, like the story quota. */
  timezone?: string | null
  sender?: MailSender | null
  from?: string | null
  db?: SupabaseClient
  now?: Date
}

export interface SendStoryResult {
  to: string
  filename: string
  bytes: number
  sentToday: number
}

async function sentOn(db: SupabaseClient, familyId: string, usageDate: string): Promise<number> {
  const { count, error } = await db
    .from('story_sends')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .eq('usage_date', usageDate)
  if (error) throw new Error(`story_sends count: ${error.message}`)
  return count ?? 0
}

export async function sendStoryToKindle(input: SendStoryInput): Promise<SendStoryResult> {
  const sender = input.sender === undefined ? smtpSender() : input.sender
  const from = input.from === undefined ? kindleFromAddress() : input.from
  if (!sender || !from) {
    throw new KindleSendError('not_configured', 'Send to Kindle is not set up on this server yet.')
  }
  const to = normalizeKindleAddress(input.kindleEmail ?? '')
  if (!to || !isKindleAddress(to)) {
    throw new KindleSendError('no_kindle_address', 'Add your Kindle address in Settings first.')
  }

  const db = input.db ?? supabaseService()
  const now = input.now ?? new Date()
  const usageDate = usageDateFor(safeTimeZone(input.timezone), now)

  // Reserve the day's slot BEFORE sending, then count. Parallel requests each insert and
  // each see the others, so the cap holds under concurrency (a burst may refuse a few that
  // would have fitted - the safe side). A refused or failed send gives its row back.
  const { data: reserved, error: reserveError } = await db
    .from('story_sends')
    .insert({ family_id: input.familyId, story_id: input.story.id, to_address: to, usage_date: usageDate })
    .select('id')
    .single()
  if (reserveError || !reserved) throw new Error(`story_sends reserve: ${reserveError?.message}`)
  const release = () => db.from('story_sends').delete().eq('id', reserved.id as string)

  const sentIncludingThis = await sentOn(db, input.familyId, usageDate)
  if (sentIncludingThis > KINDLE_SENDS_PER_DAY) {
    await release()
    throw new KindleSendError(
      'daily_limit',
      `That is ${KINDLE_SENDS_PER_DAY} stories sent to your Kindle today - the most we send. Try again tomorrow.`,
    )
  }

  const content = await buildEpub({
    // The library's title is the one the parent saw; the content's is the writer's draft.
    story: { ...input.story.content, title: input.story.title },
    childNames: input.childNames,
    id: input.story.id,
  })
  const filename = epubFilename(input.story.title)
  try {
    await sender.send({
      to,
      from,
      subject: input.story.title,
      text: `${input.story.title}\n\nA StoryTime story, sent to your Kindle. Open it from your library on the device.`,
      attachment: { filename, content, contentType: EPUB_MIME },
    })
  } catch (err) {
    console.error('[kindle] delivery failed:', err instanceof Error ? err.message : err)
    await release()
    throw new KindleSendError(
      'delivery_failed',
      "We couldn't reach your Kindle just now. Nothing was changed - please try again in a minute.",
    )
  }

  return { to, filename, bytes: content.length, sentToday: sentIncludingThis }
}
