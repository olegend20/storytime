import { Inter, Newsreader } from 'next/font/google'

/**
 * Self-hosted at build time by `next/font`: the browser never talks to Google, which keeps the
 * privacy promise ("no third-party requests") true. Newsreader is a text serif with an optical
 * size axis - tighter at headline sizes, sturdier at reading sizes - used for titles and prose.
 */
export const newsreader = Newsreader({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  axes: ['opsz'],
  variable: '--font-newsreader',
  display: 'swap',
})

export const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})
