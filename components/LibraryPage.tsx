'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { fetchLibrary } from '@/lib/client/api'
import { friendlyDate, groupBySeries, type SeriesGroup } from '@/lib/client/library'
import { joinNames } from '@/lib/client/reader'
import { loadScroll } from '@/lib/client/storage'
import { readMinutes, type LibraryStory } from '@/lib/client/types'

/**
 * F9 library: grouped by series, newest first.
 *
 * The series heading is the children's first names, because a series in this product is a group
 * of kids (§3) - "Cruz & Phoenix" is what a parent is looking for at 7pm, not a topic.
 */
export function LibraryPage() {
  const [groups, setGroups] = useState<SeriesGroup[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchLibrary(controller.signal)
      .then((res) => setGroups(groupBySeries(res.stories)))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
    return () => controller.abort()
  }, [])

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 text-[clamp(1.6rem,5vw,2.1rem)]">Story library</h1>
        <Link href="/new" className="btn no-underline">
          New story
        </Link>
      </div>

      <p className="mb-8 text-sm" style={{ color: 'var(--fg-muted)' }}>
        Every story you&rsquo;ve made is here to read again, as often as you like. Re-reading is
        always free.
      </p>

      {failed && (
        <p className="card p-4" role="alert">
          We couldn&rsquo;t load your library just now. Check your connection and refresh.
        </p>
      )}

      {groups === null && !failed && <p style={{ color: 'var(--fg-muted)' }}>Loading…</p>}

      {groups !== null && groups.length === 0 && (
        <div className="card p-6">
          <h2 className="mt-0 text-xl">No stories yet</h2>
          <p style={{ color: 'var(--fg-muted)' }}>
            Tonight&rsquo;s the first one. Pick who&rsquo;s in it and what it&rsquo;s about.
          </p>
          <Link href="/new" className="btn mt-2 no-underline">
            Make tonight&rsquo;s story
          </Link>
        </div>
      )}

      {groups?.map((group) => (
        <section key={group.series_id} aria-labelledby={`series-${group.series_id}`} className="mb-10">
          <h2 id={`series-${group.series_id}`} className="mt-0 mb-1 text-xl">
            {joinNames(group.child_names) || group.series_title}
          </h2>
          <p className="mt-0 mb-4 text-sm" style={{ color: 'var(--fg-muted)' }}>
            {group.stories.length} {group.stories.length === 1 ? 'story' : 'stories'} in this series
          </p>
          <ul className="m-0 list-none space-y-3 p-0">
            {group.stories.map((story) => (
              <li key={story.id}>
                <StoryCard story={story} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}

function StoryCard({ story }: { story: LibraryStory }) {
  const [resume, setResume] = useState(false)

  useEffect(() => {
    setResume((loadScroll(story.id)?.y ?? 0) > 200)
  }, [story.id])

  return (
    <Link
      href={`/stories/${story.id}`}
      className="card block p-4 no-underline transition-colors hover:border-accent"
      style={{ color: 'var(--fg)' }}
    >
      <h3 className="mt-0 mb-1 font-read text-lg leading-snug">{story.content.title}</h3>
      {story.content.subtitle && (
        <p className="mt-0 mb-2 font-read text-sm italic" style={{ color: 'var(--fg-muted)' }}>
          {story.content.subtitle}
        </p>
      )}
      <p className="m-0 text-sm" style={{ color: 'var(--fg-muted)' }}>
        {[
          friendlyDate(story.created_at),
          `${readMinutes(story)} min read aloud`,
          `${story.content.true_facts.length} true facts`,
        ].join(' · ')}
      </p>
      <p className="mt-2 mb-0 text-sm font-semibold" style={{ color: 'var(--accent)' }}>
        {resume ? 'Continue where you stopped →' : 'Read →'}
      </p>
    </Link>
  )
}
