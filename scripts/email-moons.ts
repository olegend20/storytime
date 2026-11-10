/**
 * Draws public/email/moons.png, the ten moons in every email (issue #98). Email clients drop
 * SVG, so the landing page's moons (components/Phase.tsx) are rendered once to a PNG at 3x.
 * Run after changing the moon or the accent colour: `pnpm tsx scripts/email-moons.ts`.
 */
import { chromium } from '@playwright/test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { Phase } from '@/components/Phase'
import { EMAIL_COLORS } from '@/lib/email/layout'

const SIZE = 20
const GAP = 10

async function main() {
  const moons = Array.from({ length: 10 }, (_, i) =>
    renderToStaticMarkup(createElement(Phase, { lit: (i + 1) / 10, size: SIZE })),
  ).join('')
  const width = 10 * SIZE + 9 * GAP
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width, height: SIZE }, deviceScaleFactor: 3 })
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div id="row" style="display:flex;gap:${GAP}px;color:${EMAIL_COLORS.accent};width:${width}px;height:${SIZE}px">${moons}</div></body></html>`,
  )
  await page.locator('#row').screenshot({ path: 'public/email/moons.png', omitBackground: true })
  await browser.close()
}

void main()
