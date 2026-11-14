import { BRAND } from '@/lib/brand'
import { EMAIL_COLORS, EMAIL_SITE, MOONS, MOONS_PATH, MOONS_WIDTH, escapeHtml } from '@/lib/email/layout'
import { EMAIL } from '@/lib/landing/copy'

/**
 * The "your place is ready" email, redesigned (owner request 2026-11-13).
 *
 * Same rules as lib/email/layout.ts: tables and inline styles, no SVG, no web-font link, one
 * button, the moons PNG from lastten.org as the only image, light colour scheme. What is new is
 * the shape: a night-coloured hero with the one button, the moons as a divider, a sample page so
 * a parent can see what tonight looks like, the three steps, four promises and a quiet close.
 * Every sentence comes from EMAIL.invite / EMAIL.how in lib/landing/copy.ts, so the copy-rule
 * test still reads them.
 */

const c = {
  ...EMAIL_COLORS,
  night: '#22332d', // deep evergreen: the hero band
  nightSoft: '#cdd8cc', // body text on the night band
  nightMuted: '#9fb2a3', // small text on the night band
  moon: '#f2d98c', // the app icon's moon gold: the button and the italic word
  sand: '#efe2cc', // the site's --tint-sand: the true-fact box
} as const

const SERIF = "Newsreader, Georgia, 'Iowan Old Style', 'Times New Roman', serif"
const SANS = "Inter, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
const e = escapeHtml

function eyebrow(text: string, color: string = c.muted): string {
  return `<p style="margin:0 0 14px;font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;color:${color};">${e(text)}</p>`
}

function title(parts: readonly [string, string], size: number, color: string, accent: string, tag = 'h2'): string {
  return `<${tag} style="margin:0 0 14px;font-family:${SERIF};font-weight:400;font-size:${size}px;line-height:1.2;color:${color};letter-spacing:-0.01em;">${e(parts[0])}<em style="font-style:italic;color:${accent};">${e(parts[1])}</em></${tag}>`
}

const roman = ['i', 'ii', 'iii', 'iv', 'v']

export function renderInviteEmail(href: string): string {
  const m = EMAIL.invite
  const site = EMAIL_SITE
  const host = site.replace(/^https?:\/\//, '')
  const s = m.sample
  const steps = EMAIL.how.points
    .map(
      (p, i) => `<tr>
<td valign="top" width="52" style="padding:0 0 20px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="36" height="36" bgcolor="${c.accentSoft}" style="width:36px;height:36px;border-radius:18px;background:${c.accentSoft};font-family:${SERIF};font-style:italic;font-size:17px;line-height:36px;color:${c.accent};">${roman[i]}.</td></tr></table>
</td>
<td valign="top" style="padding:6px 0 20px;font-family:${SANS};font-size:15px;line-height:1.55;color:${c.soft};"><strong style="display:block;margin-bottom:2px;font-family:${SERIF};font-size:18px;font-weight:400;color:${c.fg};">${e(p.title)}</strong>${e(p.body)}</td>
</tr>`,
    )
    .join('\n')
  const promise = (p: { title: string; body: string }) =>
    `<td valign="top" width="50%" class="col" style="padding:0 8px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:18px 18px 16px;background:${c.card};border:1px solid ${c.border};border-radius:14px;">
<p style="margin:0 0 4px;font-family:${SERIF};font-size:17px;line-height:1.3;color:${c.fg};">${e(p.title)}</p>
<p style="margin:0;font-family:${SANS};font-size:13.5px;line-height:1.5;color:${c.soft};">${e(p.body)}</p>
</td></tr></table></td>`
  const ps = m.promises
  const promises = [0, 2]
    .map((i) => `<tr>${promise(ps[i]!)}${ps[i + 1] ? promise(ps[i + 1]!) : ''}</tr>`)
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${e(m.subject)}</title>
<style>
  :root { color-scheme: light; supported-color-schemes: light; }
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { color:${c.accent}; }
  @media (max-width: 620px) {
    .pad { padding-left:24px !important; padding-right:24px !important; }
    .hero h1 { font-size:32px !important; }
    .col { display:block !important; width:100% !important; box-sizing:border-box; }
    .btn a { display:block !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${c.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${e(m.preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}" style="background:${c.page};">
<tr><td align="center" style="padding:28px 12px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">

<!-- Wordmark -->
<tr><td align="center" style="padding:0 0 20px;">
<a href="${e(site)}" target="_blank" style="text-decoration:none;color:${c.fg};font-family:${SERIF};font-size:26px;line-height:1.2;letter-spacing:-0.01em;">${e(BRAND.wordmark)}</a>
<div style="margin-top:4px;font-family:${SANS};font-size:10.5px;letter-spacing:0.24em;text-transform:uppercase;color:${c.muted};">${e(BRAND.wordmarkByline)}</div>
</td></tr>

<!-- Hero: the night band with the one button -->
<tr><td bgcolor="${c.night}" style="background:${c.night};border-radius:20px 20px 0 0;padding:48px 44px 44px;" class="pad hero">
${eyebrow(m.eyebrow, c.moon)}
${title(m.headline, 38, c.accentFg, c.moon, 'h1')}
<p style="margin:0 0 30px;font-family:${SANS};font-size:17px;line-height:1.6;color:${c.nightSoft};">${e(m.lead)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn"><tr><td align="center" bgcolor="${c.moon}" style="border-radius:999px;background:${c.moon};">
<a href="${e(href)}" target="_blank" style="display:inline-block;padding:18px 40px;font-family:${SANS};font-size:17px;line-height:1.2;font-weight:700;color:${c.night};text-decoration:none;border-radius:999px;">${e(m.button)}&nbsp;&rarr;</a>
</td></tr></table>
<p style="margin:18px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;letter-spacing:0.02em;color:${c.moon};">${e(m.chips)}</p>
<p style="margin:10px 0 0;font-family:${SANS};font-size:13.5px;line-height:1.55;color:${c.nightMuted};">${e(m.note)}</p>
</td></tr>

<!-- Moons divider -->
<tr><td align="center" bgcolor="${c.card}" style="background:${c.card};border-left:1px solid ${c.border};border-right:1px solid ${c.border};padding:30px 20px 6px;">
<img src="${e(site + MOONS_PATH)}" width="${MOONS_WIDTH}" height="${MOONS.size}" alt="Ten moons, waxing from new to full" style="display:block;width:${MOONS_WIDTH}px;max-width:100%;height:auto;border:0;">
</td></tr>

<!-- A sample page -->
<tr><td bgcolor="${c.card}" style="background:${c.card};border-left:1px solid ${c.border};border-right:1px solid ${c.border};padding:30px 44px 8px;" class="pad">
${eyebrow(s.eyebrow)}
${title(s.title, 25, c.fg, c.accent)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:26px 28px;background:${c.page};border:1px solid ${c.border};border-radius:14px;">
<p style="margin:0 0 4px;font-family:${SANS};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;color:${c.muted};">${e(s.label)}</p>
<p style="margin:0 0 4px;font-family:${SERIF};font-size:22px;line-height:1.3;color:${c.fg};">${e(s.bookTitle)}</p>
<p style="margin:0 0 16px;font-family:${SERIF};font-style:italic;font-size:15px;color:${c.muted};">${e(s.byline)}</p>
${s.paragraphs.map((p) => `<p style="margin:0 0 12px;font-family:${SERIF};font-size:18px;line-height:1.7;color:${c.fg};">${e(p)}</p>`).join('\n')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;"><tr><td bgcolor="${c.sand}" style="padding:16px 18px;background:${c.sand};border-radius:10px;">
<p style="margin:0 0 4px;font-family:${SANS};font-size:11px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;color:${c.soft};">${e(s.factLabel)}</p>
<p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.55;color:${c.fg};">${e(s.fact)}</p>
</td></tr></table>
</td></tr></table>
<p style="margin:14px 0 0;font-family:${SANS};font-size:14px;line-height:1.55;color:${c.soft};">${e(s.caption)}</p>
</td></tr>

<!-- How it works -->
<tr><td bgcolor="${c.card}" style="background:${c.card};border-left:1px solid ${c.border};border-right:1px solid ${c.border};padding:34px 44px 18px;" class="pad">
${eyebrow(EMAIL.how.eyebrow)}
${title(EMAIL.how.title, 25, c.fg, c.accent)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">${steps}</table>
<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.55;color:${c.muted};">${e(EMAIL.how.body)}</p>
</td></tr>

<!-- Promises -->
<tr><td bgcolor="${c.accentSoft}" style="background:${c.accentSoft};border:1px solid ${c.border};border-radius:0 0 20px 20px;padding:34px 36px 22px;" class="pad">
<div style="padding:0 8px;">${eyebrow(m.promisesEyebrow)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${promises}</table>
</td></tr>

<!-- Close -->
<tr><td align="center" style="padding:40px 24px 0;">
${title(m.close, 28, c.fg, c.accent)}
<p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;"><a href="${e(href)}" target="_blank" style="color:${c.accent};font-weight:600;text-decoration:underline;">${e(m.button)}&nbsp;&rarr;</a></p>
<p style="margin:18px 0 0;font-family:${SANS};font-size:12.5px;line-height:1.55;color:${c.muted};">Button not working? Paste this link into your browser:<br><a href="${e(href)}" target="_blank" style="color:${c.accent};word-break:break-all;">${e(href)}</a></p>
</td></tr>

<!-- Footer -->
<tr><td align="center" style="padding:34px 24px 0;">
<div style="font-family:${SANS};font-size:10.5px;letter-spacing:0.24em;text-transform:uppercase;font-weight:600;color:${c.muted};">${e(BRAND.tagline)}</div>
<p style="margin:12px 0 14px;font-family:${SERIF};font-style:italic;font-size:17px;line-height:1.5;color:${c.soft};">${e(BRAND.footer)}</p>
<p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.7;color:${c.muted};">${e(m.help)} <a href="${e(site + '/about#faq-h')}" target="_blank" style="color:${c.muted};">${e(host)}/about</a><br>${e(m.reason)}<br>${e(BRAND.project)} &middot; <a href="${e(site)}" target="_blank" style="color:${c.muted};">${e(host)}</a></p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`
}

/** The plain-text part: the same words, in the same order. */
export function inviteText(href: string): string {
  const m = EMAIL.invite
  const s = m.sample
  return [
    'Hello,',
    '',
    m.headline.join(''),
    '',
    m.lead,
    '',
    `${m.button}:`,
    href,
    '',
    m.chips,
    m.note,
    '',
    `${EMAIL.how.title.join('')}`,
    ...EMAIL.how.points.map((p, i) => `${roman[i]}. ${p.title}. ${p.body}`),
    EMAIL.how.body,
    '',
    `${s.label}: ${s.bookTitle}`,
    ...s.paragraphs,
    `${s.factLabel}: ${s.fact}`,
    '',
    m.help + ' ' + EMAIL_SITE + '/about#faq-h',
    m.reason,
    '',
    'Sleep well,',
    BRAND.wordmark,
  ].join('\n')
}
