'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { describeTones, joinNames, type ReaderStory } from '@/lib/client/reader'
import { friendlyDate } from '@/lib/client/library'
import { ChapterNav } from './ChapterNav'
import { Prose } from './Prose'
import { useWakeLock } from './useWakeLock'
import { swipeDirection, type Point } from '@/lib/client/swipe'
import { ReaderControls } from './ReaderControls'
import { TrueFactsChecklist } from './TrueFactsChecklist'
import { useScrollMemory } from './useScrollMemory'

/**
 * The reader. Used both for a saved story (F9) and for a story arriving over SSE (F10).
 *
 * Layout choices all come from the same picture: one column, serif, about 34rem of measure, a
 * fixed nav bar at thumb height, and enough bottom padding that the last line of the story is
 * never hidden behind that bar.
 */
export function StoryReader({
  story,
  streaming = false,
  progress = null,
  flagged = false,
  actions,
  footer,
}: {
  story: ReaderStory
  streaming?: boolean
  progress?: number | null
  /** `quality.outcome === 'flagged'` - the soft banner the contract asks for. */
  flagged?: boolean
  /** Chrome-level actions (delete, etc). Hidden in reading mode. */
  actions?: React.ReactNode
  footer?: React.ReactNode
}) {
  /**
   * Which chapter the counter shows. While streaming it is derived - the newest chapter, by
   * definition - and only a finished story tracks the scroll position, so there is no state to
   * keep in sync with the stream.
   */
  const [scrolledTo, setScrolledTo] = useState(0)
  const current = streaming ? Math.max(0, story.chapters.length - 1) : scrolledTo
  const sectionRefs = useRef<Array<HTMLElement | null>>([])
  const headings = story.chapters.map((c) => c.heading)

  // Scroll memory only for a finished, saved story: restoring into a stream would fight the
  // prose still arriving underneath.
  useScrollMemory(streaming ? null : story.id, !streaming && story.chapters.length > 0)
  // The screen stays on while a story is open - a chapter is longer than a phone's lock timer.
  useWakeLock(story.chapters.length > 0)

  // Which chapter the parent is actually looking at. Top-third rootMargin so the heading
  // becoming visible is what changes the counter, not the section's midpoint.
  useEffect(() => {
    const nodes = sectionRefs.current.filter((n): n is HTMLElement => n !== null)
    if (nodes.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (!visible) return
        const index = Number((visible.target as HTMLElement).dataset.chapterIndex)
        if (Number.isInteger(index)) setScrolledTo(index)
      },
      { rootMargin: '0px 0px -66% 0px', threshold: 0 },
    )
    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [story.chapters.length])

  const goToChapter = useCallback((index: number) => {
    const node = sectionRefs.current[index]
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setScrolledTo(index)
  }, [])

  // Swipe to turn the page, once the story is complete (while streaming the newest chapter
  // is the one being read, and there is nothing to turn to). Pointer events, fingers only:
  // a mouse drag is how a parent selects text, and must not turn the page.
  const swipeStart = useRef<Point | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    swipeStart.current =
      e.pointerType === 'touch' || e.pointerType === 'pen'
        ? { x: e.clientX, y: e.clientY, t: Date.now() }
        : null
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const start = swipeStart.current
    swipeStart.current = null
    if (!start || streaming) return
    const dir = swipeDirection(start, { x: e.clientX, y: e.clientY, t: Date.now() })
    if (dir === 'next' && current < story.chapters.length - 1) goToChapter(current + 1)
    if (dir === 'prev' && current > 0) goToChapter(current - 1)
  }

  const meta = [
    joinNames([...story.childNames]),
    story.readMinutes ? `${story.readMinutes} min read aloud` : null,
    story.tones.length > 0 ? describeTones(story.tones) : null,
    story.createdAt ? friendlyDate(story.createdAt) : null,
  ].filter((part): part is string => Boolean(part))

  return (
    <div data-reader className="mx-auto max-w-3xl px-4 pt-6" style={{ paddingBottom: '7rem' }}>
      <div data-chrome className="mb-6">
        {progress !== null && streaming && <StreamProgress value={progress} />}
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <ReaderControls>{actions}</ReaderControls>
      </div>

      <header className="mb-8">
        <h1 className="m-0 font-read text-[clamp(1.75rem,6vw,2.5rem)] leading-tight">
          {story.title || 'Writing your story…'}
        </h1>
        {story.subtitle && (
          <p className="mt-2 mb-0 font-read text-lg italic" style={{ color: 'var(--fg-muted)' }}>
            {story.subtitle}
          </p>
        )}
        {meta.length > 0 && (
          <p data-chrome className="mt-3 mb-0 text-sm" style={{ color: 'var(--fg-muted)' }}>
            {meta.join(' · ')}
          </p>
        )}
      </header>

      {flagged && (
        <p
          className="card mb-8 p-4 text-sm"
          role="status"
          style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}
        >
          We had a second look at this one before showing it to you. If anything reads oddly,
          make another — it won&rsquo;t use one of your stories.
        </p>
      )}

      <div
        aria-live={streaming ? 'polite' : 'off'}
        aria-busy={streaming}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        data-testid="chapters"
      >
        {story.chapters.map((chapter, index) => (
          <section
            key={index}
            data-chapter-index={index}
            id={`chapter-${index}`}
            ref={(node) => {
              sectionRefs.current[index] = node
            }}
            aria-labelledby={`chapter-heading-${index}`}
            className="mb-10 scroll-mt-4"
          >
            <h2
              id={`chapter-heading-${index}`}
              className="mt-0 mb-4 font-read text-[clamp(1.25rem,4.5vw,1.6rem)] leading-snug"
            >
              {chapter.heading || `Chapter ${index + 1}`}
            </h2>
            <Prose text={chapter.text} />
            {chapter.shout_line && (
              <p className="sound mt-4 mb-0 text-center text-xl">{chapter.shout_line}</p>
            )}
          </section>
        ))}
      </div>

      {story.endingLine && (
        <section aria-label="The end" className="my-10 text-center">
          <p className="m-0 text-sm tracking-[0.2em] uppercase" style={{ color: 'var(--fg-muted)' }}>
            The End
          </p>
          <p className="prose mx-auto mt-3 mb-0 italic">{story.endingLine}</p>
        </section>
      )}

      <TrueFactsChecklist storyId={streaming ? null : story.id} facts={story.trueFacts} />

      {footer && (
        <div data-chrome className="mt-8">
          {footer}
        </div>
      )}

      {!streaming && <ChapterNav headings={headings} currentIndex={current} onGo={goToChapter} />}
    </div>
  )
}

/**
 * F10: "a subtle progress indicator". Subtle means a thin bar and a word count, not a spinner
 * and a percentage - the story itself is the feedback, this only says it is still coming.
 */
function StreamProgress({ value }: { value: number }) {
  const percent = Math.round(value * 100)
  return (
    <div>
      <div
        role="progressbar"
        aria-label="Writing the story"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--bg-sunken)' }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%`, background: 'var(--accent)' }}
        />
      </div>
      <p className="mt-2 mb-0 text-sm" style={{ color: 'var(--fg-muted)' }}>
        Writing the story… you can start reading now.
      </p>
    </div>
  )
}
