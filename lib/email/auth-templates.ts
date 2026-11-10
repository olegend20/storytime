import { renderEmail } from './layout'
import { EMAIL } from '@/lib/landing/copy'

/**
 * Sign-in mail is sent by Supabase, not by us, so its design ships as template files
 * (issue #98): supabase/templates/*.html, named in supabase/config.toml and pushed to
 * production with `supabase config push`. They are generated from the same layout as the
 * waitlist emails by scripts/email-templates.ts, and a test regenerates them so the files
 * cannot drift from the code.
 *
 * `{{ .ConfirmationURL }}` is Supabase's own placeholder for the sign-in link.
 */
export const CONFIRMATION_URL = '{{ .ConfirmationURL }}'

function signIn(): string {
  const m = EMAIL.signIn
  return renderEmail({
    preheader: m.preheader,
    eyebrow: m.eyebrow,
    headline: m.headline,
    lead: m.lead,
    button: { label: m.button, href: CONFIRMATION_URL },
    note: m.note,
    aside: EMAIL.tonight,
    reason: m.reason,
  })
}

/**
 * file name -> contents. A new account's first link is Supabase's "confirmation" email, every
 * later one is "magic_link"; to a parent both are just the sign-in link, so they are the same.
 */
export function authTemplates(): Record<string, string> {
  const html = `${signIn()}\n`
  return { 'magic_link.html': html, 'confirmation.html': html }
}

export const AUTH_TEMPLATE_SUBJECT = EMAIL.signIn.subject
/** The template kinds config.toml names, each with our subject. */
export const AUTH_TEMPLATE_KINDS = ['magic_link', 'confirmation'] as const
