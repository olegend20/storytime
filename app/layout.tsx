import type { Metadata, Viewport } from 'next'
import './globals.css'
import { SiteHeader } from '@/components/SiteHeader'
import { ThemeScript } from '@/components/ThemeScript'
import { OfflineReady } from '@/components/OfflineReady'

export const metadata: Metadata = {
  title: 'StoryTime',
  description: 'A personalized, true-fact bedtime story where your kids are the heroes.',
  manifest: '/manifest.webmanifest',
  // iOS: "Add to Home Screen" opens full-screen with no Safari chrome (DECISIONS #144).
  appleWebApp: { capable: true, title: 'StoryTime', statusBarStyle: 'black-translucent' },
}

/** F9 AC: the reader must work on a 375px phone with no horizontal scroll. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
  // The reader has its own text-size control; the browser's pinch zoom must still work too.
  maximumScale: 5,
  // Draw under the notch and the home bar; the chapter bar pads itself with the safe area.
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <a href="#main" data-chrome className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <OfflineReady />
      </body>
    </html>
  )
}
