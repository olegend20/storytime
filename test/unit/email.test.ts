import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_TEMPLATE_KINDS, AUTH_TEMPLATE_SUBJECT, authTemplates, signInUrl } from '@/lib/email/auth-templates'
import { EMAIL_SITE, MOONS_PATH, renderEmail, type EmailContent } from '@/lib/email/layout'
import { BRAND } from '@/lib/brand'
import { EMAIL } from '@/lib/landing/copy'
import { confirmMail, newConfirmToken } from '@/lib/waitlist/confirm'
import { inviteMail } from '@/lib/waitlist/invite'

/**
 * Issue #98: every email we send is in The Last Ten's design, with one button.
 */

const content: EmailContent = {
  preheader: 'Shown beside the subject',
  eyebrow: 'The waitlist',
  headline: ['One press and you are ', 'on the list.'],
  lead: 'A lead.',
  button: { label: 'Confirm my place', href: 'https://lastten.org/waitlist/confirm?token=abc&x=1' },
  note: 'A note.',
  aside: { eyebrow: 'Why', title: ['A ', 'title.'], body: 'Body.', points: [{ title: 'One', body: 'First.' }] },
  reason: 'Why you got this.',
}

/** The hrefs of every link styled as the button (padded, filled). */
function buttonHrefs(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]+)"[^>]*display:inline-block;padding/g)].map((m) => m[1]!)
}

describe('renderEmail (VT-E1)', () => {
  const html = renderEmail(content)

  it('is a whole document with the brand around the message', () => {
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('</html>')
    expect(html).toContain(`>${BRAND.wordmark}</a>`)
    expect(html).toContain(BRAND.wordmarkByline)
    expect(html).toContain(BRAND.tagline)
    expect(html).toContain(BRAND.footer)
    expect(html).toContain(BRAND.project)
    expect(html).toContain('One press and you are <em')
    expect(html).toContain('on the list.</em>')
    expect(html).toContain('Shown beside the subject')
    expect(html).toContain('Why you got this.')
  })

  it('has exactly one button, and prints its link as text as well', () => {
    const href = 'https://lastten.org/waitlist/confirm?token=abc&amp;x=1'
    expect(buttonHrefs(html)).toEqual([href])
    expect(html).toContain(`>${href}</a>`)
    expect(html).toContain('Confirm my place&nbsp;&rarr;')
  })

  it('takes the moons from the public site, as a PNG with alt text (email clients drop SVG)', () => {
    expect(EMAIL_SITE).toBe('https://lastten.org')
    expect(html).toContain(`src="https://lastten.org${MOONS_PATH}"`)
    expect(html).toMatch(/alt="Ten moons[^"]*"/)
    expect(html).not.toContain('<svg')
    expect(html, 'no third-party request on open').not.toMatch(/fonts\.googleapis|<link /)
    expect(readFileSync(join('public', MOONS_PATH)).subarray(1, 4).toString()).toBe('PNG')
  })

  it('escapes every value, so an address or a link cannot break out of the markup', () => {
    const evil = renderEmail({
      ...content,
      lead: '<script>alert(1)</script>',
      button: { label: 'Go', href: 'https://x.test/"><img src=x onerror=alert(1)>' },
      reason: `It's "you" & me`,
    })
    expect(evil).not.toContain('<script>')
    expect(evil).not.toContain('"><img')
    expect(evil).toContain('&lt;script&gt;')
    expect(evil).toContain('It&#39;s &quot;you&quot; &amp; me')
  })

  it('leaves out the note and the aside when there are none', () => {
    const bare = renderEmail({ ...content, note: undefined, aside: undefined })
    expect(bare).not.toContain('A note.')
    expect(bare).not.toContain('Body.')
    expect(buttonHrefs(bare)).toHaveLength(1)
  })
})

describe('the waitlist emails are sent as text and html (VT-E2)', () => {
  it('the confirmation email: a "Confirm my place" button to the confirm page, and why we are building it', () => {
    const token = newConfirmToken()
    const mail = confirmMail('ana@example.com', 'hello@lastten.org', 'https://lastten.org', token)
    const link = `https://lastten.org/waitlist/confirm?token=${token}`
    expect(mail.text).toContain(link)
    expect(buttonHrefs(mail.html!)).toEqual([link])
    expect(mail.html).toContain(`${EMAIL.confirm.button}&nbsp;`)
    expect(mail.html).toContain('encyclopedia')
    expect(mail.html).toContain('If this was not you')
    expect(mail.html).toContain('7 days')
  })

  it('the images and footer link point at lastten.org even when sent from a preview or localhost', () => {
    const mail = inviteMail('ana@example.com', 'hello@lastten.org', 'https://preview-xyz.vercel.app')
    expect(buttonHrefs(mail.html!)).toEqual(['https://preview-xyz.vercel.app/login?email=ana%40example.com'])
    expect(mail.html).toContain(`src="https://lastten.org${MOONS_PATH}"`)
    expect(mail.html).not.toMatch(/src="https:\/\/preview/)
  })

  it('the text part says what the html says', () => {
    const c = confirmMail('ana@example.com', 'hello@lastten.org', 'https://lastten.org', newConfirmToken())
    for (const line of [EMAIL.confirm.lead, EMAIL.confirm.note, EMAIL.confirm.reason]) expect(c.text).toContain(line)
    const i = inviteMail('ana@example.com', 'hello@lastten.org', 'https://lastten.org')
    for (const line of [EMAIL.invite.lead, EMAIL.invite.note, EMAIL.invite.reason]) expect(i.text).toContain(line)
  })

  it('the invite: a "Create my account" button to sign-in with the address filled in, and how it works', () => {
    const mail = inviteMail('ana@example.com', 'hello@lastten.org', 'https://lastten.org')
    const link = 'https://lastten.org/login?email=ana%40example.com'
    expect(mail.text).toContain(link)
    expect(buttonHrefs(mail.html!)).toEqual([link])
    expect(mail.html).toContain(`${EMAIL.invite.button}&nbsp;`)
    expect(mail.html).toContain(EMAIL.how.points[0]!.title)
  })
})

describe('the SMTP sender passes the html part through (VT-E2)', () => {
  afterEach(async () => {
    vi.doUnmock('@/lib/kindle/send')
    vi.unstubAllEnvs()
    vi.resetModules()
    ;(await import('@/lib/env')).resetEnvCache()
  })

  it('sends text and html together', async () => {
    const sendMail = vi.fn(async () => ({}))
    vi.resetModules()
    vi.doMock('@/lib/kindle/send', () => ({ smtpTransport: () => ({ sendMail }) }))
    vi.stubEnv('MAIL_FROM_EMAIL', 'hello@lastten.org')
    ;(await import('@/lib/env')).resetEnvCache()
    const { smtpInviteSender, inviteMail: invite } = await import('@/lib/waitlist/invite')
    const mail = invite('ana@example.com', 'hello@lastten.org', 'https://lastten.org')
    await smtpInviteSender()!.send(mail)
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: mail.text, html: mail.html }))
  })
})

describe('the Supabase sign-in templates (VT-E3)', () => {
  it('are the generated files, unchanged: run scripts/email-templates.ts after editing the layout or copy', () => {
    for (const [name, html] of Object.entries(authTemplates())) {
      expect(readFileSync(join('supabase', 'templates', name), 'utf8'), name).toBe(html)
      expect(html.endsWith('</html>\n'), `${name} ends in a newline, as editors leave it`).toBe(true)
    }
  })

  it('have one button, to our own /auth/link with the token Supabase fills in (VT-L1, issue #101)', () => {
    const expected = {
      'magic_link.html': '{{ .SiteURL }}/auth/link?token_hash={{ .TokenHash }}&type=magiclink',
      'confirmation.html': '{{ .SiteURL }}/auth/link?token_hash={{ .TokenHash }}&type=signup',
    }
    expect(signInUrl('magiclink')).toBe(expected['magic_link.html'])
    for (const [name, html] of Object.entries(authTemplates())) {
      const href = expected[name as keyof typeof expected].replace('&', '&amp;')
      expect(buttonHrefs(html), name).toEqual([href])
      expect(html, 'the printed link is the same').toContain(`>${href}</a>`)
      expect(html).not.toContain('ConfirmationURL')
      expect(html).not.toContain('supabase.co')
      expect(html).toContain(`${EMAIL.signIn.button}&nbsp;`)
      expect(html).toContain('src="https://lastten.org/email/moons.png"')
    }
  })

  it('config.toml sends both sign-in emails with them, under our subject', () => {
    const config = readFileSync(join('supabase', 'config.toml'), 'utf8')
    for (const kind of AUTH_TEMPLATE_KINDS) {
      const block = config.split(`[auth.email.template.${kind}]`)[1]?.split('\n[')[0] ?? ''
      expect(block, kind).toContain(`content_path = "./supabase/templates/${kind}.html"`)
      expect(block, kind).toContain(`subject = "${AUTH_TEMPLATE_SUBJECT}"`)
    }
  })
})
