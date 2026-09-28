'use client'

import { useState } from 'react'
import { ChildInput, type ReadingLevel } from '@/lib/schemas'
import { FIELD_MAX_LENGTH } from '@/lib/guardrails/sanitize'

/**
 * F3: the child form, used for both "add" and "edit".
 *
 * Client-side validation uses the same `ChildInput` schema the API route uses, so the two
 * cannot drift (F3 AC: "validation on client and server"). The server remains the
 * authority - this only saves the parent a round trip.
 */

export interface ChildDraft {
  first_name: string
  age: string
  likes: string[]
  notes: string
  reading_level: '' | ReadingLevel
}

export const EMPTY_DRAFT: ChildDraft = {
  first_name: '',
  age: '',
  likes: [],
  notes: '',
  reading_level: '',
}

export function draftFromChild(child: {
  first_name: string
  age: number
  likes: string[]
  notes: string | null
  reading_level: ReadingLevel | null
}): ChildDraft {
  return {
    first_name: child.first_name,
    age: String(child.age),
    likes: [...child.likes],
    notes: child.notes ?? '',
    reading_level: child.reading_level ?? '',
  }
}

export interface ChildPayload {
  first_name: string
  age: number
  likes: string[]
  notes: string | null
  reading_level: ReadingLevel | null
}

const MAX_LIKES = 10

const inputClass =
  'w-full rounded-lg border border-black/15 bg-white px-3 py-2 text-base dark:border-white/20 dark:bg-white/5'

export default function ChildForm({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  submitLabel,
  busy,
  serverError,
}: {
  draft: ChildDraft
  setDraft: (next: ChildDraft) => void
  onSubmit: (payload: ChildPayload) => void
  onCancel?: () => void
  submitLabel: string
  busy: boolean
  serverError: string | null
}) {
  const [error, setError] = useState<string | null>(null)
  const [likeDraft, setLikeDraft] = useState('')

  function addLike() {
    const tag = likeDraft.trim()
    if (tag === '') return
    if (draft.likes.length >= MAX_LIKES) {
      setError(`Up to ${MAX_LIKES} likes per child.`)
      return
    }
    if (draft.likes.some((l) => l.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
      setLikeDraft('')
      return
    }
    setDraft({ ...draft, likes: [...draft.likes, tag.slice(0, FIELD_MAX_LENGTH.like)] })
    setLikeDraft('')
    setError(null)
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const candidate = {
      first_name: draft.first_name,
      age: draft.age.trim() === '' ? Number.NaN : Number(draft.age),
      likes: draft.likes,
      notes: draft.notes.trim() === '' ? null : draft.notes,
      reading_level: draft.reading_level === '' ? null : draft.reading_level,
    }
    if (!Number.isFinite(candidate.age)) {
      setError('Age must be between 1 and 17.')
      return
    }
    const parsed = ChildInput.safeParse(candidate)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Please check the details.')
      return
    }
    setError(null)
    onSubmit(parsed.data)
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="sm:flex-1">
          <label htmlFor="first_name" className="block text-sm font-medium">
            First name
          </label>
          <input
            id="first_name"
            name="first_name"
            value={draft.first_name}
            maxLength={FIELD_MAX_LENGTH.first_name}
            onChange={(e) => setDraft({ ...draft, first_name: e.target.value })}
            className={`mt-1.5 ${inputClass}`}
            autoComplete="off"
            required
          />
          <p className="mt-1 mb-0 text-xs opacity-55">First name only — never a surname.</p>
        </div>
        <div className="sm:w-28">
          <label htmlFor="age" className="block text-sm font-medium">
            Age
          </label>
          <input
            id="age"
            name="age"
            type="number"
            inputMode="numeric"
            min={1}
            max={17}
            value={draft.age}
            onChange={(e) => setDraft({ ...draft, age: e.target.value })}
            className={`mt-1.5 ${inputClass}`}
            required
          />
        </div>
      </div>

      <div>
        <label htmlFor="like" className="block text-sm font-medium">
          Likes <span className="font-normal opacity-55">({draft.likes.length}/{MAX_LIKES})</span>
        </label>
        {draft.likes.length > 0 ? (
          <ul className="mt-2 mb-2 flex list-none flex-wrap gap-2 p-0">
            {draft.likes.map((like) => (
              <li
                key={like}
                className="flex items-center gap-1.5 rounded-full border border-black/15 px-2.5 py-1 text-sm dark:border-white/20"
              >
                {like}
                <button
                  type="button"
                  aria-label={`Remove ${like}`}
                  onClick={() =>
                    setDraft({ ...draft, likes: draft.likes.filter((l) => l !== like) })
                  }
                  className="opacity-55 hover:opacity-100"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-1.5 flex gap-2">
          <input
            id="like"
            value={likeDraft}
            maxLength={FIELD_MAX_LENGTH.like}
            placeholder="football"
            onChange={(e) => setLikeDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addLike()
              }
            }}
            className={inputClass}
            autoComplete="off"
          />
          <button
            type="button"
            onClick={addLike}
            disabled={draft.likes.length >= MAX_LIKES}
            className="shrink-0 rounded-lg border border-black/15 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
          >
            Add
          </button>
        </div>
      </div>

      <div>
        <label htmlFor="notes" className="block text-sm font-medium">
          Notes <span className="font-normal opacity-55">(optional)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          value={draft.notes}
          maxLength={FIELD_MAX_LENGTH.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          className={`mt-1.5 ${inputClass}`}
          placeholder="Loves goalkeeping; a bit wary of the dark."
        />
        <p className="mt-1 mb-0 text-xs opacity-55">
          {draft.notes.length}/{FIELD_MAX_LENGTH.notes}
        </p>
      </div>

      <div>
        <label htmlFor="reading_level" className="block text-sm font-medium">
          Reading level <span className="font-normal opacity-55">(optional)</span>
        </label>
        <select
          id="reading_level"
          name="reading_level"
          value={draft.reading_level}
          onChange={(e) =>
            setDraft({ ...draft, reading_level: e.target.value as ChildDraft['reading_level'] })
          }
          className={`mt-1.5 ${inputClass}`}
        >
          <option value="">Match their age</option>
          <option value="younger">Younger than their age</option>
          <option value="typical">Typical for their age</option>
          <option value="older">Older than their age</option>
        </select>
      </div>

      {error ?? serverError ? (
        <p role="alert" className="m-0 text-sm text-red-700 dark:text-red-400">
          {error ?? serverError}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-paper disabled:opacity-60 dark:bg-paper dark:text-ink"
        >
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
