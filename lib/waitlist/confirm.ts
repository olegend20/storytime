import { createHash, randomBytes } from 'node:crypto'
import { BRAND } from '@/lib/brand'
import type { InviteMail } from './invite'

/**
 * Double opt-in (issue #95): the confirmation token and its email. The same SMTP sender as the
 * invite carries it (`InviteSender`), so there is one mail seam for the waitlist.
 */

/** One confirmation email per address per day: the form cannot be used to flood an inbox. */
export const CONFIRM_RESEND_AFTER_MS = 24 * 60 * 60 * 1000
/**
 * At most this many confirmation emails a day, across all addresses. Sign-in links go out
 * through the same mail account (Resend's free plan allows 100 a day), so a bot joining with
 * thousands of addresses must not use up the mail parents need to sign in. Past the cap the
 * address is kept, unconfirmed, and joining again tomorrow sends its link.
 */
export const CONFIRM_EMAILS_PER_DAY = 40
/** The window the cap counts over. */
export const CONFIRM_CAP_WINDOW_MS = 24 * 60 * 60 * 1000
/** A link works for a week; an address nobody confirms is deleted after the same week. */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * An address that was never emailed (held back by the daily cap, or the send failed) never
 * had the chance to confirm, so it is kept longer before being forgotten; joining again in
 * that time sends its link.
 */
export const UNSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** 32 random bytes, URL-safe. Goes in the email only; the table keeps its hash. */
export function newConfirmToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashConfirmToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A token as it can arrive from a link: base64url, 43 characters. Anything else is refused unread. */
export function isConfirmToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export function confirmMail(to: string, from: string, origin: string, token: string): InviteMail {
  const link = new URL('/waitlist/confirm', origin)
  link.searchParams.set('token', token)
  return {
    to,
    from: `${BRAND.wordmark} <${from}>`,
    subject: `Confirm your place on the waitlist for ${BRAND.wordmark}`,
    text: [
      'Hello,',
      '',
      `Someone, hopefully you, asked to join the waitlist for ${BRAND.wordmark} with this address.`,
      '',
      'Confirm your place here:',
      link.toString(),
      '',
      'The link works for 7 days. We will email you again when your place is ready.',
      '',
      'If this was not you, ignore this email and we will forget the address.',
      '',
      'Sleep well,',
      BRAND.wordmark,
    ].join('\n'),
  }
}
