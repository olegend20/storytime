'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from '@/components/Icons'
import { fetchLibrary } from '@/lib/client/api'
import { friendlyDate, groupBySeries, type SeriesGroup } from '@/lib/client/library'
import { joinNames } from '@/lib/client/reader'
import { NullableScrollMemory, scrollKey } from '@/lib/client/storage'
import { useHydrated } from '@/lib/client/useHydrated'
import { useStoredJson } from '@/lib/client/useStored'
import { readMinutes, type LibraryStory } from '@/lib/client/types'

/**
 * F9 library: grouped by series, newest first.
 *
 * The series heading is the children's first names, because a series in this product is a group
 * of kids (§3) - "Milo & Juno" is what a parent is looking for at 7pm, not a topic.
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
    <main id="main" className="st-main">
      <div className="st-library">
        <div className="st-library-head">
          <div>
            <h1 className="st-h1 st-h1-page">Your story library</h1>
            <p className="st-lead">Little adventures, ready to read again. Always free.</p>
          </div>
          <Link href="/new" className="st-primary st-primary-inline">
            Make tonight&rsquo;s book <ArrowRight />
          </Link>
        </div>

        {failed && (
          <p className="card mt-8 p-4" role="alert">
            We couldn&rsquo;t load your library just now. Check your connection and refresh.
          </p>
        )}

        {groups === null && !failed && <p className="st-library-wait">Opening your library…</p>}

        {groups !== null && groups.length === 0 && (
          <div className="st-empty">
            <h2>Your first story is waiting to happen.</h2>
            <p>Choose your heroes and a little curiosity. We&rsquo;ll turn them into tonight&rsquo;s book.</p>
          </div>
        )}

        {groups?.map((group) => (
          <section key={group.series_id} aria-labelledby={`series-${group.series_id}`} className="st-group">
            <h2 id={`series-${group.series_id}`} className="st-group-title">
              {joinNames(group.child_names) || group.series_title}
            </h2>
            <p className="st-group-count">
              {group.stories.length} {group.stories.length === 1 ? 'book' : 'books'}
              {group.child_names.length > 1 ? ' together' : ''}
            </p>
            <ul className="st-rows">
              {group.stories.map((story) => (
                <li key={story.id}>
                  <StoryRow story={story} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}

/** A story is "in progress" when the remembered position is far enough in to be worth resuming. */
const RESUME_THRESHOLD_PX = 200

/** Three quiet tints for the text-only covers; a story keeps its colour from one visit to the next. */
const TINTS = ['sage', 'mist', 'sand'] as const
function coverTint(storyId: string): (typeof TINTS)[number] {
  let hash = 0
  for (const ch of storyId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return TINTS[hash % TINTS.length]!
}

/**
 * One book on the shelf: a small typeset cover (text only - there are no cover images and no
 * field to store one), the title, when it was made, and what a tap will do. The whole row is
 * the link, so the target is as big as the row.
 */
function StoryRow({ story }: { story: LibraryStory }) {
  // null = this browser has never had the story open; a position near the top = opened, and
  // finished or sent back to the start; further in = stopped part-way.
  const saved = useStoredJson(scrollKey(story.id), NullableScrollMemory, null)
  const action = saved === null ? 'Read' : saved.y > RESUME_THRESHOLD_PX ? 'Continue reading' : 'Read again'
  // What this browser remembers is only known once hydrated; until then the label keeps its
  // place but is not shown, so a row never flashes "Read" before "Continue reading".
  const hydrated = useHydrated()

  return (
    <Link href={`/stories/${story.id}`} className="st-row">
      <div className="st-cover" data-tint={coverTint(story.id)} aria-hidden="true">
        <span>{story.content.title}</span>
      </div>
      <div className="st-row-main">
        <h3 className="st-row-title">{story.content.title}</h3>
        <p className="st-row-meta">
          <span>{friendlyDate(story.created_at)}</span>
          <span>{readMinutes(story)} min read aloud</span>
          <span>{story.content.true_facts.length} true facts</span>
        </p>
      </div>
      <div className="st-row-action" style={hydrated ? undefined : { visibility: 'hidden' }}>
        {action}
        <ArrowRight width={16} height={16} />
      </div>
    </Link>
  )
}
