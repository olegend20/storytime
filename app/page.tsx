import Link from 'next/link'
import { PrivacyNote } from '@/components/PrivacyCopy'

/**
 * Home. One primary action, because at 7pm there is only one thing a parent came here to do.
 *
 * Tap budget (F10 AC, ≤3 taps before typing the topic): "Make tonight's story" is tap 1, the
 * topic field on `/new` is focused automatically, so typing starts on tap 2 at the latest.
 *
 * `?deleted=1` is where `DELETE /api/account` sends the parent (F2). It has to be
 * acknowledged somewhere, and this is the only page left that they can still see.
 */
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const justDeleted = params.deleted === '1'

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mt-0 mb-3 text-[clamp(1.9rem,7vw,2.75rem)] leading-tight">StoryTime</h1>
      <p className="mb-8 text-lg" style={{ lineHeight: 1.6 }}>
        A new bedtime story every night, about anything your kids want to learn — with your kids as
        the heroes, and the true facts at the end.
      </p>

      {justDeleted ? (
        <p
          role="status"
          className="mt-6 mb-8 rounded-xl border border-black/10 bg-black/[0.02] p-4 text-sm dark:border-white/15 dark:bg-white/[0.04]"
        >
          Your account and everything in it has been deleted. Thank you for trying StoryTime.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <Link href="/new" className="btn no-underline">
          Make tonight&rsquo;s story
        </Link>
        <Link href="/library" className="btn btn-quiet no-underline">
          Story library
        </Link>
      </div>

      <ul className="mt-10 list-none space-y-3 p-0" style={{ color: 'var(--fg-muted)' }}>
        <li>Three new stories a night, free.</li>
        <li>Five, ten or fifteen minutes of reading aloud — you choose.</li>
        <li>Every story ends with the true facts behind it.</li>
        <li>Characters and running jokes carry over from one night to the next.</li>
      </ul>

      <PrivacyNote className="mt-10" />
    </main>
  )
}
