'use client'

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
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
import { TONE_LABELS } from '@/lib/client/form'
import { joinNames, readerFromStream } from '@/lib/client/reader'
import {
  DEFAULT_FORM_MEMORY,
  FORM_KEY,
  StoryFormMemory,
  loadFormMemory,
  saveFormMemory,
} from '@/lib/client/storage'
import { useStoredJson } from '@/lib/client/useStored'
import {
  offsetForDay,
  recallSuggestedTopics,
  rememberSuggestedTopics,
  suggestedChips,
  type SuggestedTopic,
} from '@/lib/client/topics'
import { checkTopic } from '@/lib/client/validate'
import type { Child, LengthMinutes, QuotaResponse, Tone } from '@/lib/schemas'
import type { CreatorInitial } from '@/lib/newstory/initial'
import { StoryReader } from '@/components/reader/StoryReader'
import { ArrowRight, ChevronDown } from '@/components/Icons'
import { Phase } from '@/components/Phase'
import { PrivacyNote } from '@/components/PrivacyCopy'
import { GenerationError } from './GenerationError'
import { HeroesCard } from './HeroesCard'
import { LengthPicker, TonePicker } from './Pickers'
import { QuotaIndicator, resetTimeLabel } from './QuotaIndicator'
import { TopicField } from './TopicField'
import { Waiting } from './Waiting'

/** How many ideas sit under the topic field (the calm design shows three; the pool rotates). */
const CHIPS_SHOWN = 3

/**
 * F10, the nightly flow: creator → calm waiting → streaming reader → saved story.
 *
 * This is the one creator: `/` (signed in), `/dashboard` and `/new` all mount it (issue #17).
 *
 * Tap budget (AC: "≤3 taps before typing the topic on a phone"). Children and length are restored
 * from the last story, tones default to funny + exciting, every child is selected on a first
 * visit, and tone and length sit behind "Story options" with their values in view — so reaching
 * the topic costs one tap at most. With a mouse the field is focused for you; on a touch screen
 * it is not, so the keyboard does not jump up before the parent has looked at the page.
 *
 * A pre-stream failure never navigates away: the form keeps its contents so the parent can edit
 * the topic instead of retyping it.
 */
export function NewStoryFlow({
  below,
  initial,
}: {
  /** Shown under the creator (the dashboard's family strip). */
  below?: ReactNode
  /**
   * What the page that mounts this already read on the server (`/` and `/dashboard`): the
   * creator then opens complete and asks the API for nothing until the parent acts.
   */
  initial?: CreatorInitial
} = {}) {
  const [children, setChildren] = useState<Child[] | null>(initial?.children ?? null)
  const [quota, setQuota] = useState<QuotaResponse | null>(initial?.quota ?? null)
  const [serverTopics, setServerTopics] = useState<readonly SuggestedTopic[]>(initial?.topics ?? [])
  const [chipOffset, setChipOffset] = useState(() => offsetForDay())
  /** Where the three visible ideas start within the row of eight. */
  const [chipStart, setChipStart] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  /** Bumped by the retry button so the load effect runs again. */
  const [loadAttempt, setLoadAttempt] = useState(0)

  /**
   * The remembered children and length (F10 AC), read through the external store rather than a
   * `useState` initializer.
   *
   * This matters and it cost a failing test to find: `/new` is statically prerendered, so the
   * server markup has the default length selected. React does not re-apply mismatched ATTRIBUTES
   * during hydration, so a `useState(() => loadFormMemory())` initializer left `aria-checked` on
   * the wrong length button even though the state was right - the parent's remembered "15 min"
   * silently looked unselected. `useSyncExternalStore` renders the server snapshot during
   * hydration and then re-renders normally with the stored value, which does patch the DOM.
   *
   * `draft` is null until the parent touches something, so the form follows storage until then.
   */
  const remembered = useStoredJson(FORM_KEY, StoryFormMemory, DEFAULT_FORM_MEMORY)
  const [draft, setDraft] = useState<StoryFormState | null>(null)
  const allChildIds = useMemo(() => (children ?? []).map((c) => c.id), [children])
  const form = draft ?? initialFormState(remembered, allChildIds)
  const setForm = useCallback(
    (update: (current: StoryFormState) => StoryFormState) =>
      setDraft((current) => update(current ?? initialFormState(loadFormMemory(), allChildIds))),
    [allChildIds],
  )
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
    // Only ask for what the page does not already have: whatever the server passed in, and
    // topic ideas this browser session has seen in the last few minutes. "Try again" asks
    // for everything.
    const first = loadAttempt === 0
    const recalled = recallSuggestedTopics()
    Promise.all([
      first && initial?.children
        ? null
        : fetchChildren(controller.signal).then((res) => {
            setChildren(res.children)
            setLoadFailed(false)
          }),
      first && initial?.quota ? null : refreshQuota(controller.signal),
      first && initial?.topics
        ? null
        : recalled
          ? Promise.resolve().then(() => setServerTopics(recalled))
          : fetchSuggestedTopics(controller.signal)
            .then((res) => {
              setServerTopics(res.topics)
              rememberSuggestedTopics(res.topics)
            })
            .catch(() => setServerTopics([])),
    ]).catch(() => {
      if (!controller.signal.aborted) setLoadFailed(true)
    })
    return () => controller.abort()
    // `initial` is a server-rendered prop: it does not change after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshQuota, loadAttempt])

  /**
   * The remembered selection can name a child who has since been removed, so the effective
   * selection is derived rather than corrected in an effect - `form.childIds` stays the parent's
   * stated intent, and this is what we act on.
   */
  const selectedIds = useMemo(
    () => (children ? form.childIds.filter((id) => children.some((c) => c.id === id)) : []),
    [children, form.childIds],
  )

  // Focus the topic field once, and only when there is nothing else to decide first: this is what
  // turns the returning-parent case into zero taps before typing.
  useEffect(() => {
    if (focusedOnce.current || !children || stream.phase !== 'idle') return
    if (selectedIds.length === 0) return
    focusedOnce.current = true
    // A fine pointer means a keyboard is already there; on touch, focus would summon one.
    if (window.matchMedia?.('(pointer: fine)').matches) topicRef.current?.focus({ preventScroll: true })
  }, [children, selectedIds.length, stream.phase])

  // The row is still built eight at a time (ready fact packs first); three are on show, and
  // "More ideas" walks along the row before turning it over for a fresh eight.
  const chipRow = useMemo(
    () => suggestedChips({ fromServer: serverTopics, offset: chipOffset }),
    [serverTopics, chipOffset],
  )
  const chips = useMemo(
    () => chipRow.slice(chipStart, chipStart + CHIPS_SHOWN),
    [chipRow, chipStart],
  )
  const moreIdeas = useCallback(() => {
    if (chipStart + CHIPS_SHOWN * 2 <= chipRow.length) return setChipStart(chipStart + CHIPS_SHOWN)
    setChipStart(0)
    setChipOffset((o) => o + chipRow.length)
  }, [chipStart, chipRow.length])

  // ------------------------------------------------------------------ submit
  /** The form as it will actually be submitted: stated intent minus children that are gone. */
  const effectiveForm = useMemo<StoryFormState>(
    () => ({ ...form, childIds: selectedIds }),
    [form, selectedIds],
  )
  const topicCheck = checkTopic(form.topic)
  const blocker = formBlocker(effectiveForm)
  const quotaLeft = quota ? Math.max(0, quota.limit - quota.used) : null
  const quotaBlocked = quotaLeft === 0 || quota?.generation_enabled === false
  const resetLabel = resetTimeLabel(quota?.resets_at)
  const busy = stream.phase === 'connecting' || stream.phase === 'streaming'

  const submit = useCallback(async () => {
    if (busy) return
    const body = formToBody(effectiveForm)
    if (!body) {
      setShowTopicError(true)
      topicRef.current?.focus()
      return
    }
    setShowTopicError(false)
    // F10 AC: "the form remembers the last-used children and length".
    saveFormMemory({ childIds: effectiveForm.childIds, lengthMinutes: effectiveForm.lengthMinutes })

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
  }, [busy, effectiveForm, refreshQuota])

  useEffect(() => () => abortRef.current?.abort(), [])

  const backToForm = useCallback(() => {
    abortRef.current?.abort()
    dispatch({ kind: 'reset' })
  }, [])

  // ------------------------------------------------------------------ views
  const selectedChildren = (children ?? []).filter((c) => selectedIds.includes(c.id))
  const readerStory = readerFromStream(stream, {
    childNames: selectedChildren.map((c) => c.first_name),
    tones: form.tones,
  })

  // Waiting for the writer, quietly. The reader takes over the moment the title (`meta`)
  // arrives; until then the moon shows the stage the server has reached.
  const names = selectedChildren.map((c) => c.first_name)
  if ((stream.phase === 'connecting' || stream.phase === 'streaming') && !stream.meta) {
    return (
      <main id="main" className="st-main">
        <Waiting
          names={names}
          topicLabel={stream.facts?.topic_label ?? null}
          stage={stream.facts ? 'writing' : 'facts'}
          onCancel={backToForm}
        />
      </main>
    )
  }

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

  const optionsSummary = `${form.tones.map((t) => TONE_LABELS[t]).join(' + ') || 'No feeling chosen'} · ${form.lengthMinutes} min`
  const paused = quota?.generation_enabled === false
  const note = quotaBlocked
    ? paused
      ? 'New stories are paused right now. Everything in your library is still there to read.'
      : `That's all ${quota?.limit ?? 3} for today${resetLabel ? ` — your next story unlocks at ${resetLabel}` : ''}.`
    : blocker === 'no_children'
      ? 'Pick who the story is about.'
      : blocker === 'no_tone'
        ? 'Pick at least one feeling in Story options.'
        : `Free for families · ${form.lengthMinutes} min read aloud`
  const sampleA = names[0] ?? 'Milo'
  const sampleB = names.length === 0 ? 'Juno' : names[1]
  const sampleNames = names.length === 0 ? 'Milo & Juno' : joinNames(names)

  return (
    <main id="main" className="st-main">
      <div className="st-home">
        <div className="st-creator">
          <p className="st-eyebrow">Ten minutes. Together.</p>
          <h1 className="st-h1">
            Make the last ten minutes <em>memorable.</em>
          </h1>
          <p className="st-lead">
            A bedtime story where your children are the heroes, and there’s something new to discover.
          </p>

          {loadFailed && (
            <div className="card mt-6 p-4" role="alert">
              <p className="mt-0 mb-3">
                We couldn&rsquo;t load your family details. Nothing is lost — have another go.
              </p>
              {/* A dead form with no way out is the worst version of this failure. */}
              <button type="button" className="btn btn-quiet" onClick={() => setLoadAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          )}

          {stream.error && (
            <div className="mt-6">
              <GenerationError error={stream.error} onRetry={quotaBlocked ? undefined : () => void submit()} />
            </div>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <HeroesCard
              options={loadFailed && children === null ? [] : children}
              selected={selectedIds}
              onToggle={(id) => setForm((f) => toggleChild(f, id))}
            />

            <TopicField
              value={form.topic}
              onChange={(topic) => setForm((f) => ({ ...f, topic }))}
              chips={chips}
              onShuffle={moreIdeas}
              message={showTopicError && !topicCheck.ok ? topicCheck.message : null}
              inputRef={topicRef}
            />

            {/* Open by itself when the thing blocking the story is inside it. */}
            <details className="st-options" open={blocker === 'no_tone' ? true : undefined}>
              <summary>
                <span>Story options</span>
                <span className="st-options-summary">
                  <span data-testid="options-summary">{optionsSummary}</span>
                  <ChevronDown width={16} height={16} className="st-chev" />
                </span>
              </summary>
              <div className="st-options-body">
                <TonePicker selected={form.tones} onToggle={(tone: Tone) => setForm((f) => toggleTone(f, tone))} />
                <LengthPicker
                  value={form.lengthMinutes}
                  onChange={(lengthMinutes: LengthMinutes) => setForm((f) => ({ ...f, lengthMinutes }))}
                />
              </div>
            </details>

            <button
              type="submit"
              className="st-primary st-submit"
              disabled={busy || quotaBlocked || blocker === 'no_children' || blocker === 'no_tone'}
            >
              Make tonight’s book <ArrowRight />
            </button>
            <p className="st-note" aria-live="polite">
              {note}
            </p>
            <div className="st-quota">
              <QuotaIndicator quota={quota} />
            </div>
          </form>
        </div>

        <aside className="st-sample" aria-label="A sample of a bedtime book">
          <p className="st-sample-label">A sample of a bedtime book</p>
          <div className="st-book">
            <p className="st-book-by">A story starring {sampleNames}</p>
            <p className="st-book-title">{sampleNames} and the Moon’s Secret</p>
            <div className="st-ornament" aria-hidden>
              <i />
              <Phase lit={0.28} size={13} />
              <i />
            </div>
            <div className="st-book-prose">
              <p className="st-dropcap">
                {sampleB
                  ? `${sampleA} was pulling the blanket up, chin-high, when ${sampleB} noticed a little silver light on the windowsill.`
                  : `${sampleA} was pulling the blanket up, chin-high, when a little silver light appeared on the windowsill.`}
              </p>
              <p>
                “I think the Moon has left {sampleB ? 'us' : 'me'} a question,” {sampleB ?? sampleA} whispered.
              </p>
            </div>
            <span className="st-book-folio" aria-hidden>
              1
            </span>
          </div>
          <p className="st-sample-caption">Their names. Their curiosity. Your time together.</p>
        </aside>
      </div>
      <PrivacyNote className="st-privacy-note" />
      {below}
    </main>
  )
}
