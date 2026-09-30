import type { MetadataRoute } from 'next'

/**
 * Web app manifest (DECISIONS #144): "Add to Home Screen" gives StoryTime its own icon and a
 * full-screen window with no browser chrome around the story. `start_url` is the library,
 * because a returning parent at bedtime is there to read, not to sign in again.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'StoryTime',
    short_name: 'StoryTime',
    description: 'A personalized, true-fact bedtime story where your kids are the heroes.',
    start_url: '/library',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#fbf8f2',
    theme_color: '#fbf8f2',
    icons: [
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  }
}
