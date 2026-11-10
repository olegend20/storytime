import { serverEnv } from '@/lib/env'
import { smtpTransport } from '@/lib/kindle/send'
import { BRAND } from '@/lib/brand'
import { renderEmail } from '@/lib/email/layout'
import { EMAIL } from '@/lib/landing/copy'

/**
 * "Your place is ready" (issue #92): sent once, when the owner approves an address.
 *
 * `InviteSender` is the seam, as `MailSender` is for Kindle: production uses SMTP (the same
 * provider as sign-in mail), tests inject a recorder, and with no SMTP or no sender address
 * there is no sender at all - the owner page then says the email was not sent.
 */

export interface InviteMail {
  to: string
  from: string
  subject: string
  text: string
  /** The branded version (issue #98); `text` is always sent with it. */
  html?: string
}

export interface InviteSender {
  send(mail: InviteMail): Promise<void>
}

export function inviteFromAddress(): string | null {
  const env = serverEnv()
  return env.MAIL_FROM_EMAIL ?? env.KINDLE_FROM_EMAIL ?? null
}

export function smtpInviteSender(): InviteSender | null {
  const t = smtpTransport()
  if (!t || !inviteFromAddress()) return null
  return {
    async send(mail) {
      await t.sendMail({ to: mail.to, from: mail.from, subject: mail.subject, text: mail.text, html: mail.html })
    },
  }
}

/** The email itself. `origin` is the site the owner approved from, e.g. https://lastten.org. */
export function inviteMail(to: string, from: string, origin: string): InviteMail {
  const login = new URL('/login', origin)
  login.searchParams.set('email', to)
  const m = EMAIL.invite
  return {
    to,
    from: `${BRAND.wordmark} <${from}>`,
    subject: m.subject,
    // The same words as the html part, so a client showing plain text says the same thing.
    text: ['Hello,', '', m.lead, '', `${m.button}:`, login.toString(), '', m.note, '', m.reason, '', 'Sleep well,', BRAND.wordmark].join('\n'),
    html: renderEmail({
      preheader: m.preheader,
      eyebrow: m.eyebrow,
      headline: m.headline,
      lead: m.lead,
      button: { label: m.button, href: login.toString() },
      note: m.note,
      aside: EMAIL.how,
      reason: m.reason,
    }),
  }
}

/**
 * What a waitlist route needs to send mail: the sender (null when mail is not set up, or the
 * env cannot be read) and the site its links point at - SITE_URL, so a preview deployment or
 * localhost still links parents to lastten.org, else the request's own origin.
 */
export function waitlistMail(requestOrigin: string): { sender: InviteSender | null; origin: string } {
  try {
    return { sender: smtpInviteSender(), origin: serverEnv().SITE_URL ?? requestOrigin }
  } catch {
    return { sender: null, origin: requestOrigin }
  }
}
