import type { Metadata, Viewport } from 'next'
import './globals.css'
import { PrefsProvider } from '@/components/PrefsProvider'
import { SiteHeader } from '@/components/SiteHeader'
import { ThemeScript } from '@/components/ThemeScript'

export const metadata: Metadata = {
  title: 'StoryTime',
  description: 'A personalized, true-fact bedtime story where your kids are the heroes.',
}

/** F9 AC: the reader must work on a 375px phone with no horizontal scroll. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  // The reader's text-size control exists; the browser's pinch zoom must still work too.
  maximumScale: 5,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <PrefsProvider>
          <a href="#main" data-chrome className="skip-link">
            Skip to content
          </a>
          <SiteHeader />
          {children}
        </PrefsProvider>
      </body>
    </html>
  )
}
