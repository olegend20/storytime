'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ApiError, deleteStory, fetchStory } from '@/lib/client/api'
import { ArrowRight } from '@/components/Icons'
import { KindleStatus, SendToKindleButton, useSendToKindle } from '@/components/reader/SendToKindleButton'
import { readerFromLibraryStory } from '@/lib/client/reader'
import { forgetStory, saveScroll } from '@/lib/client/storage'
import type { LibraryStory } from '@/lib/client/types'
import { StoryReader } from './reader/StoryReader'

/**
 * A saved story (F9).
 *
 * The only request this page makes is a GET of stored content. That is the whole point of the
 * AC "opening a saved story makes zero model calls": re-reading last night's story must be free,
 * because re-reading is what children actually do.
 */
export function StoryPage({ id }: { id: string }) {
  const router = useRouter()
  const [story, setStory] = useState<LibraryStory | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const kindle = useSendToKindle(id)
  const [deleteFailed, setDeleteFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchStory(id, controller.signal)
      .then((res) => {
        setStory(res.story)
        setState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState(error instanceof ApiError && error.status === 404 ? 'missing' : 'error')
      })
    return () => controller.abort()
  }, [id])

  const readAgain = useCallback(() => {
    // Clearing the stored position is part of "read again": otherwise the next open jumps back
    // to where last night's reading stopped.
    saveScroll(id, 0)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [id])

  if (state === 'loading') {
    return (
      <main id="main" className="st-main st-main-narrow">
        <p style={{ color: 'var(--fg-muted)' }}>Opening the story…</p>
      </main>
    )
  }

  if (state === 'missing' || (state === 'ready' && !story)) {
    return (
      <main id="main" className="st-main st-main-narrow">
        <h1 className="st-h1 st-h1-page">That story isn&rsquo;t here any more</h1>
        <p style={{ color: 'var(--fg-muted)' }}>
          It may have been deleted. Everything else is still in your library.
        </p>
        <Link href="/library" className="btn mt-4 no-underline">
          Back to the library
        </Link>
      </main>
    )
  }

  if (state === 'error' || !story) {
    return (
      <main id="main" className="st-main st-main-narrow">
        <h1 className="st-h1 st-h1-page">We couldn&rsquo;t open that story</h1>
        <p style={{ color: 'var(--fg-muted)' }}>
          Nothing is lost — check your connection and try again.
        </p>
        <Link href="/library" className="btn btn-quiet mt-4 no-underline">
          Back to the library
        </Link>
      </main>
    )
  }

  return (
    <main id="main">
      <StoryReader
        story={readerFromLibraryStory(story)}
        flagged={story.status === 'flagged'}
        // Shown on the page, not in the menu: it must still be there once the menu has closed.
        notice={
          <>
            <KindleStatus state={kindle.state} />
            {deleteFailed && (
              <p role="alert" className="st-rnotice" data-testid="delete-error">
                We couldn&rsquo;t delete that story. Nothing was removed — please try again.
              </p>
            )}
          </>
        }
        actions={
          <>
            <SendToKindleButton state={kindle.state} onSend={() => void kindle.send()} />
            <DeleteStoryButton
              onFailed={setDeleteFailed}
              onConfirm={async () => {
                await deleteStory(story.id)
                forgetStory(story.id)
                router.push('/library')
              }}
            />
          </>
        }
        footer={
          <div className="st-again">
            <h2>Read it again?</h2>
            <p>Re-reading a story is always free. It never uses one of tonight&rsquo;s new stories.</p>
            <div className="st-again-actions">
              <button type="button" className="btn btn-quiet" onClick={readAgain}>
                Read again
              </button>
              <Link href="/library" className="btn btn-quiet no-underline">
                Back to library
              </Link>
              <Link href="/new" className="st-primary st-primary-inline">
                Make another book <ArrowRight />
              </Link>
            </div>
          </div>
        }
      />
    </main>
  )
}

/**
 * Delete, behind one confirmation (F9 "delete story"; F11 "one-click delete" from the parent's
 * side). Inline rather than `window.confirm`: a native dialog cannot be styled for a dark room
 * and cannot say what deletion actually does. A failure is reported to the page, which shows
 * it under the reader's controls: the confirmation lives in a menu, and a message inside a
 * menu disappears the moment the menu closes.
 */
function DeleteStoryButton({
  onConfirm,
  onFailed,
}: {
  onConfirm: () => Promise<void>
  /** Told when a delete fails (and when a retry starts), so the page can say so outside the menu. */
  onFailed: (failed: boolean) => void
}) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!asking) {
    return (
      <button type="button" className="btn btn-quiet btn-danger" onClick={() => setAsking(true)}>
        Delete story
      </button>
    )
  }

  return (
    <div
      className="card w-full p-3"
      style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}
    >
      <p className="mt-0 mb-3 text-sm">
        Delete this story for good? The characters and running jokes it added stay in the series
        — deleting a story doesn&rsquo;t rewind the series.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-quiet btn-danger"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            onFailed(false)
            onConfirm().catch(() => {
              setBusy(false)
              onFailed(true)
            })
          }}
        >
          {busy ? 'Deleting…' : 'Yes, delete it'}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy}
          onClick={() => setAsking(false)}
        >
          Keep it
        </button>
      </div>
    </div>
  )
}
