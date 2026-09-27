import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'StoryTime',
  description: 'A personalized, true-fact bedtime story where your kids are the heroes.',
}

/** F9 AC: the reader must work on a 375px phone with no horizontal scroll. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
