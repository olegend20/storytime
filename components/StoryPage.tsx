'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ApiError, deleteStory, fetchStory } from '@/lib/client/api'
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
      <main id="main" className="mx-auto max-w-3xl px-4 py-12">
        <p style={{ color: 'var(--fg-muted)' }}>Opening the story…</p>
      </main>
    )
  }

  if (state === 'missing' || (state === 'ready' && !story)) {
    return (
      <main id="main" className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="mt-0 text-2xl">That story isn&rsquo;t here any more</h1>
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
      <main id="main" className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="mt-0 text-2xl">We couldn&rsquo;t open that story</h1>
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
        actions={
          <DeleteStoryButton
            onConfirm={async () => {
              await deleteStory(story.id)
              forgetStory(story.id)
              router.push('/library')
            }}
          />
        }
        footer={
          <div className="card p-4 sm:p-6">
            <h2 className="mt-0 mb-2 text-lg">Read it again?</h2>
            <p className="mt-0 mb-4 text-sm" style={{ color: 'var(--fg-muted)' }}>
              Re-reading a story is always free. It never uses one of tonight&rsquo;s three
              stories.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn" onClick={readAgain}>
                Read again
              </button>
              <Link href="/library" className="btn btn-quiet no-underline">
                Library
              </Link>
              <Link href="/new" className="btn btn-quiet no-underline">
                New story
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
 * and cannot say what deletion actually does.
 */
function DeleteStoryButton({ onConfirm }: { onConfirm: () => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

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
      {failed && (
        <p className="mt-0 mb-3 text-sm" role="alert">
          That didn&rsquo;t work. Please try again.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-quiet btn-danger"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setFailed(false)
            onConfirm().catch(() => {
              setBusy(false)
              setFailed(true)
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
