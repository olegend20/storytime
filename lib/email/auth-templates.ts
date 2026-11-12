import { renderEmail } from './layout'
import { EMAIL } from '@/lib/landing/copy'

/**
 * Sign-in mail is sent by Supabase, not by us, so its design ships as template files
 * (issue #98): supabase/templates/*.html, named in supabase/config.toml and pushed to
 * production with `supabase config push`. They are generated from the same layout as the
 * waitlist emails by scripts/email-templates.ts, and a test regenerates them so the files
 * cannot drift from the code.
 *
 * The link is on our own site rather than Supabase's `{{ .ConfirmationURL }}` (issue #101):
 * parents see lastten.org. /auth/link passes it on to Supabase's check, so it still only works
 * in the browser that asked (DECISIONS #219). `{{ .SiteURL }}` is the project's site_url -
 * lastten.org in production, the dev server locally. A new account's first link is a
 * `signup`, every later one a `magiclink`.
 */
export function signInUrl(type: 'magiclink' | 'signup'): string {
  return `{{ .SiteURL }}/auth/link?token_hash={{ .TokenHash }}&type=${type}`
}

function signIn(type: 'magiclink' | 'signup'): string {
  const m = EMAIL.signIn
  return renderEmail({
    preheader: m.preheader,
    eyebrow: m.eyebrow,
    headline: m.headline,
    lead: m.lead,
    button: { label: m.button, href: signInUrl(type) },
    note: m.note,
    aside: EMAIL.tonight,
    reason: m.reason,
  })
}

/**
 * file name -> contents. A new account's first link is Supabase's "confirmation" email, every
 * later one is "magic_link"; to a parent both are just the sign-in link, so they look the same.
 */
export function authTemplates(): Record<string, string> {
  return { 'magic_link.html': `${signIn('magiclink')}\n`, 'confirmation.html': `${signIn('signup')}\n` }
}

export const AUTH_TEMPLATE_SUBJECT = EMAIL.signIn.subject
/** The template kinds config.toml names, each with our subject. */
export const AUTH_TEMPLATE_KINDS = ['magic_link', 'confirmation'] as const
