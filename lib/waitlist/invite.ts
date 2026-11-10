import { serverEnv } from '@/lib/env'
import { smtpTransport } from '@/lib/kindle/send'
import { BRAND } from '@/lib/brand'

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
      await t.sendMail({ to: mail.to, from: mail.from, subject: mail.subject, text: mail.text })
    },
  }
}

/** The email itself. `origin` is the site the owner approved from, e.g. https://lastten.org. */
export function inviteMail(to: string, from: string, origin: string): InviteMail {
  const login = new URL('/login', origin)
  login.searchParams.set('email', to)
  return {
    to,
    from: `${BRAND.wordmark} <${from}>`,
    subject: `Your place at ${BRAND.wordmark} is ready`,
    text: [
      'Hello,',
      '',
      `Thank you for joining the waitlist. Your place at ${BRAND.wordmark} is ready.`,
      '',
      'Create your account here:',
      login.toString(),
      '',
      'Enter this email address and we will send you a sign-in link. There is no password.',
      '',
      'Sleep well,',
      BRAND.wordmark,
    ].join('\n'),
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
