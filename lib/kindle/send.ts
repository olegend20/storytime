import type { SupabaseClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import { serverEnv } from '@/lib/env'
import { supabaseService } from '@/lib/supabase/service'
import type { StoryOutput } from '@/lib/schemas'
import { isKindleAddress } from './address'
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

/** The configured SMTP transport, or null when the feature is not set up. */
export function smtpSender(): MailSender | null {
  const env = serverEnv()
  if (!env.SMTP_HOST || !env.KINDLE_FROM_EMAIL) return null
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
  })
  return {
    async send(mail) {
      await transport.sendMail({
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

export function kindleFromAddress(): string | null {
  return serverEnv().KINDLE_FROM_EMAIL ?? null
}

export interface SendStoryInput {
  familyId: string
  /** The parent's saved address; null when none is set. */
  kindleEmail: string | null
  story: { id: string; title: string; content: StoryOutput }
  childNames: readonly string[]
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

async function sentToday(db: SupabaseClient, familyId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await db
    .from('story_sends')
    .select('id', { count: 'exact', head: true })
    .eq('family_id', familyId)
    .gte('created_at', since)
  if (error) throw new Error(`story_sends count: ${error.message}`)
  return count ?? 0
}

export async function sendStoryToKindle(input: SendStoryInput): Promise<SendStoryResult> {
  const sender = input.sender === undefined ? smtpSender() : input.sender
  const from = input.from === undefined ? kindleFromAddress() : input.from
  if (!sender || !from) {
    throw new KindleSendError('not_configured', 'Send to Kindle is not set up on this server yet.')
  }
  const to = input.kindleEmail?.trim().toLowerCase() ?? ''
  if (!to || !isKindleAddress(to)) {
    throw new KindleSendError('no_kindle_address', 'Add your Kindle address in Settings first.')
  }

  const db = input.db ?? supabaseService()
  const now = input.now ?? new Date()
  const already = await sentToday(db, input.familyId, now)
  if (already >= KINDLE_SENDS_PER_DAY) {
    throw new KindleSendError(
      'daily_limit',
      `That is ${KINDLE_SENDS_PER_DAY} stories sent to your Kindle in a day - the most we send. Try again tomorrow.`,
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
    throw new KindleSendError(
      'delivery_failed',
      "We couldn't reach your Kindle just now. Nothing was changed - please try again in a minute.",
    )
  }

  const { error } = await db
    .from('story_sends')
    .insert({ family_id: input.familyId, story_id: input.story.id, to_address: to })
  if (error) console.error(`[kindle] send not logged: ${error.message}`)

  return { to, filename, bytes: content.length, sentToday: already + 1 }
}
