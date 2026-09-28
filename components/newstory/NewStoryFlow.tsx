'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import Link from 'next/link'
import { fetchChildren, fetchQuota, fetchSuggestedTopics } from '@/lib/client/api'
import {
  initialStreamState,
  readGenerationEvents,
  startGeneration,
  streamProgress,
  streamReducer,
} from '@/lib/client/generate'
import {
  formBlocker,
  formToBody,
  initialFormState,
  toggleChild,
  toggleTone,
  type StoryFormState,
} from '@/lib/client/form'
import { readerFromStream } from '@/lib/client/reader'
import { loadFormMemory, saveFormMemory } from '@/lib/client/storage'
import { offsetForDay, suggestedChips, type SuggestedTopic } from '@/lib/client/topics'
import { checkTopic } from '@/lib/client/validate'
import type { Child, LengthMinutes, QuotaResponse, Tone } from '@/lib/schemas'
import { StoryReader } from '@/components/reader/StoryReader'
import { PrivacyNote } from '@/components/PrivacyCopy'
import { GenerationError } from './GenerationError'
import { ChildPicker, LengthPicker, TonePicker } from './Pickers'
import { QuotaIndicator, resetTimeLabel } from './QuotaIndicator'
import { TopicField } from './TopicField'

/**
 * F10, the nightly flow: form → streaming reader → saved story.
 *
 * Tap budget (AC: "≤3 taps before typing the topic on a phone"). Children and length are
 * restored from the last story, tones default to funny + exciting, and the topic field is focused
 * once the form is ready — so the returning case is *zero* taps before typing, and the
 * first-ever case is one (pick a child).
 *
 * A pre-stream failure never navigates away: the form keeps its contents so the parent can edit
 * the topic instead of retyping it.
 */
export function NewStoryFlow() {
  const [children, setChildren] = useState<Child[] | null>(null)
  const [quota, setQuota] = useState<QuotaResponse | null>(null)
  const [serverTopics, setServerTopics] = useState<readonly SuggestedTopic[]>([])
  const [chipOffset, setChipOffset] = useState(() => offsetForDay())
  const [loadFailed, setLoadFailed] = useState(false)

  const [form, setForm] = useState<StoryFormState>(() => initialFormState(loadFormMemory()))
  const [showTopicError, setShowTopicError] = useState(false)
  const [stream, dispatch] = useReducer(streamReducer, initialStreamState)
  const abortRef = useRef<AbortController | null>(null)
  const topicRef = useRef<HTMLInputElement>(null)
  const focusedOnce = useRef(false)

  // ------------------------------------------------------------------ load
  const refreshQuota = useCallback((signal?: AbortSignal) => {
    return fetchQuota(signal)
      .then(setQuota)
      .catch(() => {
        /* the indicator simply stays hidden; it must never block the form */
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetchChildren(controller.signal).then((res) => setChildren(res.children)),
      refreshQuota(controller.signal),
      fetchSuggestedTopics(controller.signal)
        .then((res) => setServerTopics(res.topics))
        .catch(() => setServerTopics([])),
    ]).catch(() => {
      if (!controller.signal.aborted) setLoadFailed(true)
    })
    return () => controller.abort()
  }, [refreshQuota])

  // Restore the remembered children, dropping any that no longer exist.
  useEffect(() => {
    if (!children) return
    setForm((current) => {
      const valid = current.childIds.filter((id) => children.some((c) => c.id === id))
      return valid.length === current.childIds.length ? current : { ...current, childIds: valid }
    })
  }, [children])

  // Focus the topic field once, and only when there is nothing else to decide first.
  useEffect(() => {
    if (focusedOnce.current || !children || stream.phase !== 'idle') return
    if (form.childIds.length === 0) return
    focusedOnce.current = true
    topicRef.current?.focus({ preventScroll: true })
  }, [children, form.childIds.length, stream.phase])

  const chips = useMemo(
    () => suggestedChips({ fromServer: serverTopics, offset: chipOffset }),
    [serverTopics, chipOffset],
  )

  // ------------------------------------------------------------------ submit
  const topicCheck = checkTopic(form.topic)
  const blocker = formBlocker(form)
  const quotaLeft = quota ? Math.max(0, quota.limit - quota.used) : null
  const quotaBlocked = quotaLeft === 0 || quota?.generation_enabled === false
  const resetLabel = resetTimeLabel(quota?.resets_at)
  const busy = stream.phase === 'connecting' || stream.phase === 'streaming'

  const submit = useCallback(async () => {
    if (busy) return
    const body = formToBody(form)
    if (!body) {
      setShowTopicError(true)
      topicRef.current?.focus()
      return
    }
    setShowTopicError(false)
    saveFormMemory({ childIds: form.childIds, lengthMinutes: form.lengthMinutes })

    dispatch({ kind: 'start' })
    const controller = new AbortController()
    abortRef.current = controller

    const started = await startGeneration(body, controller.signal)
    if (!started.ok || !started.stream) {
      // Pre-stream failure: back to the form with the message and the contents intact.
      dispatch({ kind: 'fail', error: started.error ?? { code: 'generation_failed', message: 'Please try again.', quota_consumed: false, resets_at: null } })
      void refreshQuota()
      return
    }
    for await (const action of readGenerationEvents(started.stream, controller.signal)) {
      dispatch(action)
    }
    void refreshQuota()
  }, [busy, form, refreshQuota])

  useEffect(() => () => abortRef.current?.abort(), [])

  const backToForm = useCallback(() => {
    abortRef.current?.abort()
    dispatch({ kind: 'reset' })
  }, [])

  // ------------------------------------------------------------------ views
  const selectedChildren = (children ?? []).filter((c) => form.childIds.includes(c.id))
  const readerStory = readerFromStream(stream, {
    childNames: selectedChildren.map((c) => c.first_name),
    tones: form.tones,
  })

  // Streaming, or finished: the reader takes over the page.
  if (stream.phase === 'streaming' || stream.phase === 'done' || stream.meta) {
    return (
      <main id="main">
        {stream.error && (
          <div className="mx-auto max-w-3xl space-y-3 px-4 pt-6">
            <GenerationError error={stream.error} onRetry={() => void submit()} />
            <button type="button" className="btn btn-quiet" onClick={backToForm}>
              Change the topic
            </button>
          </div>
        )}
        <StoryReader
          story={readerStory}
          streaming={stream.phase !== 'done' && stream.phase !== 'error'}
          progress={streamProgress(stream)}
          flagged={stream.quality?.outcome === 'flagged'}
          footer={
            stream.phase === 'done' ? (
              <div className="card p-4 sm:p-6">
                <h2 className="mt-0 mb-2 text-lg">Saved to your library</h2>
                <p className="mt-0 mb-4 text-sm" style={{ color: 'var(--fg-muted)' }}>
                  You can read it again any night — re-reading is always free.
                </p>
                <QuotaIndicator quota={quota} />
                <div className="mt-4 flex flex-wrap gap-2">
                  {readerStory.id && (
                    <Link href={`/stories/${readerStory.id}`} className="btn no-underline">
                      Open the saved story
                    </Link>
                  )}
                  <Link href="/library" className="btn btn-quiet no-underline">
                    Library
                  </Link>
                </div>
              </div>
            ) : null
          }
        />
      </main>
    )
  }

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="m-0 text-[clamp(1.6rem,5vw,2.1rem)]">Tonight&rsquo;s story</h1>
        <QuotaIndicator quota={quota} />
      </div>

      {loadFailed && (
        <p className="card mb-6 p-4" role="alert">
          We couldn&rsquo;t load your family details. Check your connection and refresh.
        </p>
      )}

      {stream.error && (
        <div className="mb-6">
          <GenerationError
            error={stream.error}
            onRetry={quotaBlocked ? undefined : () => void submit()}
          />
        </div>
      )}

      <form
        className="space-y-7"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {children === null ? (
          <p style={{ color: 'var(--fg-muted)' }}>Loading your children…</p>
        ) : children.length === 0 ? (
          <p className="card p-4">
            Add a child first and we&rsquo;ll make them the hero of tonight&rsquo;s story.
          </p>
        ) : (
          <ChildPicker
            children={children}
            selected={form.childIds}
            onToggle={(id) => setForm((f) => toggleChild(f, id))}
          />
        )}

        <TopicField
          value={form.topic}
          onChange={(topic) => setForm((f) => ({ ...f, topic }))}
          chips={chips}
          onShuffle={() => setChipOffset((o) => o + 8)}
          message={showTopicError && !topicCheck.ok ? topicCheck.message : null}
          inputRef={topicRef}
        />

        <TonePicker
          selected={form.tones}
          onToggle={(tone: Tone) => setForm((f) => toggleTone(f, tone))}
        />

        <LengthPicker
          value={form.lengthMinutes}
          onChange={(lengthMinutes: LengthMinutes) => setForm((f) => ({ ...f, lengthMinutes }))}
        />

        <div>
          <button
            type="submit"
            className="btn w-full"
            disabled={busy || quotaBlocked || blocker === 'no_children' || blocker === 'no_tone'}
          >
            {busy ? 'Writing…' : 'Start the story'}
          </button>
          <p className="mt-2 mb-0 text-sm" style={{ color: 'var(--fg-muted)' }} aria-live="polite">
            {quotaBlocked
              ? quota && quota.generation_enabled === false
                ? 'New stories are paused right now. Everything in your library is still there to read.'
                : `That's all ${quota?.limit ?? 3} for today${resetLabel ? ` — your next story unlocks at ${resetLabel}` : ''}.`
              : blocker === 'no_children'
                ? 'Pick who the story is about.'
                : blocker === 'no_tone'
                  ? 'Pick at least one feeling.'
                  : 'It starts reading within a few seconds.'}
          </p>
        </div>
      </form>

      <PrivacyNote className="mt-10" />
    </main>
  )
}
