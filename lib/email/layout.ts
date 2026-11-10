import { BRAND } from '@/lib/brand'

/**
 * Every email we send, in The Last Ten's clothes (issue #98): the cream page, the green, a serif
 * headline with its one italic word, one large button, the ten moons and the tagline.
 *
 * Email clients are not browsers, so this is the old dialect on purpose: tables for layout,
 * styles inline, no SVG (Gmail drops it - the moons are a PNG), web fonts only as a nicety with
 * Georgia and system sans behind them. The button is a padded link inside a table cell, so it is
 * one large target everywhere and still a link where styles are stripped. The same link is
 * printed under it as text for clients that block buttons, and every email also carries a
 * plain-text part.
 *
 * Light only (`color-scheme: light`): a half-inverted cream page reads worse than a cream page.
 */

/** The colours of the light theme in app/globals.css, which an email cannot read. */
export const EMAIL_COLORS = {
  page: '#f6f4ee',
  card: '#fffdf8',
  sunken: '#eeece4',
  fg: '#293a34',
  soft: '#46554e',
  muted: '#626c63',
  border: '#dcded3',
  accent: '#355c49',
  accentFg: '#fffdf8',
  accentSoft: '#e9eee3',
} as const

/** The moons row, served from public/ (scripts/email-moons.ts draws it). 386 x 26 at 1x. */
export const MOONS_PATH = '/email/moons.png'

const SERIF = "Newsreader, Georgia, 'Iowan Old Style', 'Times New Roman', serif"
const SANS = "Inter, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

export interface EmailBlock {
  /** Small caps over the title, as on the site. */
  eyebrow: string
  /** [before, the emphasised word(s)] - the second part is set in italic green. */
  title: readonly [string, string]
  body: string
}

export interface EmailContent {
  /** The line an inbox shows beside the subject. */
  preheader: string
  eyebrow: string
  /** [before, the emphasised word(s)]. */
  headline: readonly [string, string]
  lead: string
  button: { label: string; href: string }
  /** Under the button, e.g. how long the link works. */
  note?: string
  /** A short piece of the project's own words, below the action. */
  aside?: EmailBlock & { points?: ReadonlyArray<{ title: string; body: string }> }
  /** Why this email arrived, and what to do if it was not wanted. */
  reason: string
  /** The site the moons and the footer link point at, e.g. https://lastten.org. */
  origin: string
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const c = EMAIL_COLORS
const e = escapeHtml

function headline(parts: readonly [string, string], size: number): string {
  return `<h1 style="margin:0 0 16px;font-family:${SERIF};font-weight:400;font-size:${size}px;line-height:1.18;color:${c.fg};letter-spacing:-0.01em;">${e(parts[0])}<em style="font-style:italic;color:${c.accent};">${e(parts[1])}</em></h1>`
}

function eyebrow(text: string): string {
  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;color:${c.muted};">${e(text)}</p>`
}

function button(label: string, href: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0;">
<tr><td align="center" bgcolor="${c.accent}" style="border-radius:999px;background:${c.accent};">
<a href="${e(href)}" target="_blank" style="display:inline-block;padding:17px 38px;font-family:${SANS};font-size:17px;line-height:1.2;font-weight:600;color:${c.accentFg};text-decoration:none;border-radius:999px;">${e(label)}&nbsp;&rarr;</a>
</td></tr></table>`
}

function aside(block: NonNullable<EmailContent['aside']>): string {
  const points = (block.points ?? [])
    .map(
      (p, i) => `<tr>
<td valign="top" width="34" style="padding:14px 0 0;font-family:${SERIF};font-style:italic;font-size:17px;line-height:1.4;color:${c.accent};">${['i.', 'ii.', 'iii.', 'iv.'][i] ?? ''}</td>
<td valign="top" style="padding:14px 0 0;font-family:${SANS};font-size:15px;line-height:1.55;color:${c.soft};"><strong style="color:${c.fg};font-weight:600;">${e(p.title)}.</strong> ${e(p.body)}</td>
</tr>`,
    )
    .join('\n')
  return `<tr><td style="padding:34px 44px 38px;background:${c.accentSoft};border-top:1px solid ${c.border};" class="pad">
${eyebrow(block.eyebrow)}
<h2 style="margin:0 0 12px;font-family:${SERIF};font-weight:400;font-size:23px;line-height:1.25;color:${c.fg};">${e(block.title[0])}<em style="font-style:italic;color:${c.accent};">${e(block.title[1])}</em></h2>
<p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${c.soft};">${e(block.body)}</p>
${points ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">${points}</table>` : ''}
</td></tr>`
}

/** The whole HTML document. Every value is escaped, so a link or an address cannot break out. */
export function renderEmail(m: EmailContent): string {
  const site = m.origin.replace(/\/+$/, '')
  const host = site.replace(/^https?:\/\//, '')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${e(m.headline.join(''))}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&family=Newsreader:ital,wght@0,400;1,400&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light; supported-color-schemes: light; }
  body { margin:0; padding:0; }
  a { color:${c.accent}; }
  @media (max-width: 620px) {
    .pad { padding-left:26px !important; padding-right:26px !important; }
    .h1 h1 { font-size:30px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${c.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${e(m.preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}" style="background:${c.page};">
<tr><td align="center" style="padding:36px 14px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;">

<tr><td align="center" style="padding:0 0 22px;">
<a href="${e(site)}" target="_blank" style="text-decoration:none;color:${c.fg};font-family:${SERIF};font-size:24px;line-height:1.2;letter-spacing:-0.01em;">${e(BRAND.wordmark)}</a>
<div style="margin-top:4px;font-family:${SANS};font-size:10.5px;letter-spacing:0.24em;text-transform:uppercase;color:${c.muted};">${e(BRAND.wordmarkByline)}</div>
</td></tr>

<tr><td style="background:${c.card};border:1px solid ${c.border};border-radius:18px;overflow:hidden;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:44px 44px 40px;" class="pad h1">
${eyebrow(m.eyebrow)}
${headline(m.headline, 36)}
<p style="margin:0 0 26px;font-family:${SANS};font-size:17px;line-height:1.6;color:${c.soft};">${e(m.lead)}</p>
${button(m.button.label, m.button.href)}
${m.note ? `<p style="margin:18px 0 0;font-family:${SANS};font-size:13.5px;line-height:1.55;color:${c.muted};">${e(m.note)}</p>` : ''}
<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid ${c.border};font-family:${SANS};font-size:12.5px;line-height:1.55;color:${c.muted};">Button not working? Paste this link into your browser:<br><a href="${e(m.button.href)}" target="_blank" style="color:${c.accent};word-break:break-all;">${e(m.button.href)}</a></p>
</td></tr>
${m.aside ? aside(m.aside) : ''}
</table>
</td></tr>

<tr><td align="center" style="padding:38px 10px 0;">
<img src="${e(site + MOONS_PATH)}" width="290" height="20" alt="Ten moons, waxing from new to full" style="display:block;width:290px;max-width:100%;height:auto;border:0;">
<div style="margin-top:16px;font-family:${SANS};font-size:10.5px;letter-spacing:0.24em;text-transform:uppercase;font-weight:600;color:${c.muted};">${e(BRAND.tagline)}</div>
</td></tr>

<tr><td align="center" style="padding:26px 26px 0;">
<p style="margin:0 0 14px;font-family:${SERIF};font-style:italic;font-size:17px;line-height:1.5;color:${c.soft};">${e(BRAND.footer)}</p>
<p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${c.muted};">${e(m.reason)}<br>${e(BRAND.project)} &middot; <a href="${e(site)}" target="_blank" style="color:${c.muted};">${e(host)}</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`
}
