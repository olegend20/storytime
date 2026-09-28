import Link from 'next/link'
import { PrivacyPromises } from '@/components/PrivacyCopy'

export const metadata = {
  title: 'Privacy · StoryTime',
  description: 'What StoryTime stores about your children, and what it never will.',
}

/**
 * F11's privacy page, content side.
 *
 * COORDINATION NOTE for the lead: lane 1 owns "the privacy page's server route" per the lane
 * split. This file is the copy only - no data access, no auth, nothing server-side. If lane 1
 * lands its own `app/privacy/page.tsx`, it should import `PrivacyPromises` from
 * `components/PrivacyCopy.tsx` rather than restate the promises, so the in-app note and the page
 * cannot end up saying different things.
 */
export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mt-0 text-[clamp(1.6rem,5vw,2.1rem)]">Our privacy promise</h1>
      <p className="mb-8 text-lg" style={{ color: 'var(--fg-muted)' }}>
        StoryTime is for children, so the safest thing we can do with their data is not have it.
      </p>

      <PrivacyPromises />

      <h2 className="mt-10 text-xl">What we do keep</h2>
      <p style={{ color: 'var(--fg-muted)' }}>
        Your email address, so you can sign in. Your children&rsquo;s first names, ages, likes and
        any note you add. The stories we make for you, so you can read them again. That is the
        whole list.
      </p>

      <h2 className="mt-8 text-xl">Topics we won&rsquo;t write about</h2>
      <p style={{ color: 'var(--fg-muted)' }}>
        StoryTime writes learning adventures — history, science, nature, technology, sport, how
        things work. It declines anything frightening or adult, and it will not write a story about
        a real private person such as a classmate or a neighbour. If a topic is turned down, it
        does not use one of your three stories for the day.
      </p>

      <p className="mt-10">
        <Link href="/new" style={{ color: 'var(--accent)' }}>
          Back to tonight&rsquo;s story
        </Link>
      </p>
    </main>
  )
}
