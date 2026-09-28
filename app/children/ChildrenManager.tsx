'use client'

import { useState } from 'react'
import { MAX_CHILDREN_PER_FAMILY, type ReadingLevel } from '@/lib/schemas'
import ChildForm, {
  draftFromChild,
  EMPTY_DRAFT,
  type ChildDraft,
  type ChildPayload,
} from './ChildForm'

/**
 * F3: the children list with add / edit / delete.
 *
 * Every write goes through /api/children, so the server-side validation, the 8-child
 * ceiling and the HTML rejection all apply exactly as they would to any other client.
 */

export interface ChildView {
  id: string
  first_name: string
  age: number
  likes: string[]
  notes: string | null
  reading_level: ReadingLevel | null
}

const READING_LEVEL_LABEL: Record<ReadingLevel, string> = {
  younger: 'reads younger',
  typical: 'reads typical',
  older: 'reads older',
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string }
    return body.message ?? 'Something went wrong. Please try again.'
  } catch {
    return 'Something went wrong. Please try again.'
  }
}

export default function ChildrenManager({ initial }: { initial: ChildView[] }) {
  const [children, setChildren] = useState<ChildView[]>(initial)
  const [adding, setAdding] = useState(initial.length === 0)
  const [addDraft, setAddDraft] = useState<ChildDraft>(EMPTY_DRAFT)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<ChildDraft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const atLimit = children.length >= MAX_CHILDREN_PER_FAMILY

  async function create(payload: ChildPayload) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/children', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await readError(response))
      return
    }
    const { child } = (await response.json()) as { child: ChildView }
    setChildren((current) => [...current, child])
    setAddDraft(EMPTY_DRAFT)
    setAdding(false)
    setNotice(`${child.first_name} added.`)
  }

  async function save(id: string, payload: ChildPayload) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/children/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setBusy(false)
    if (!response.ok) {
      setError(await readError(response))
      return
    }
    const { child } = (await response.json()) as { child: ChildView }
    setChildren((current) => current.map((c) => (c.id === id ? child : c)))
    setEditingId(null)
    setNotice(`${child.first_name} updated.`)
  }

  async function remove(child: ChildView) {
    const confirmed = window.confirm(
      `Remove ${child.first_name}? Stories you have already made stay in your library.`,
    )
    if (!confirmed) return
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/children/${child.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!response.ok) {
      setError(await readError(response))
      return
    }
    const body = (await response.json()) as { affected_series?: number }
    setChildren((current) => current.filter((c) => c.id !== child.id))
    setEditingId(null)
    setNotice(
      body.affected_series
        ? `${child.first_name} removed. Past stories they appear in are still in your library.`
        : `${child.first_name} removed.`,
    )
  }

  return (
    <div>
      {notice ? (
        <p role="status" className="mb-4 mt-0 text-sm opacity-75">
          {notice}
        </p>
      ) : null}

      {children.length > 0 ? (
        <ul className="m-0 mb-6 list-none space-y-3 p-0">
          {children.map((child) => (
            <li
              key={child.id}
              data-testid="child-row"
              className="rounded-xl border border-black/10 p-4 dark:border-white/15"
            >
              {editingId === child.id ? (
                <ChildForm
                  draft={editDraft}
                  setDraft={setEditDraft}
                  onSubmit={(payload) => save(child.id, payload)}
                  onCancel={() => setEditingId(null)}
                  submitLabel="Save changes"
                  busy={busy}
                  serverError={error}
                />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="m-0 font-semibold">
                      {child.first_name}{' '}
                      <span className="font-normal opacity-60">· {child.age}</span>
                    </p>
                    {child.likes.length > 0 ? (
                      <p className="mt-1 mb-0 text-sm opacity-75">{child.likes.join(' · ')}</p>
                    ) : null}
                    {child.notes ? (
                      <p className="mt-1 mb-0 text-sm opacity-60">{child.notes}</p>
                    ) : null}
                    {child.reading_level ? (
                      <p className="mt-1 mb-0 text-xs opacity-55">
                        {READING_LEVEL_LABEL[child.reading_level]}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditDraft(draftFromChild(child))
                        setEditingId(child.id)
                        setError(null)
                      }}
                      className="rounded-lg border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(child)}
                      className="rounded-lg border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-0 mb-6 text-sm opacity-70">
          No children yet. Add the first one and tonight&apos;s story can be about them.
        </p>
      )}

      {adding ? (
        <div className="rounded-xl border border-black/10 p-4 dark:border-white/15">
          <h2 className="mt-0 mb-4 text-base font-semibold">Add a child</h2>
          <ChildForm
            draft={addDraft}
            setDraft={setAddDraft}
            onSubmit={create}
            onCancel={children.length > 0 ? () => setAdding(false) : undefined}
            submitLabel="Add child"
            busy={busy}
            serverError={error}
          />
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => {
              setAdding(true)
              setError(null)
            }}
            disabled={atLimit}
            className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
          >
            Add a child
          </button>
          {atLimit ? (
            <p className="mt-2 mb-0 text-sm opacity-65">
              You can add up to {MAX_CHILDREN_PER_FAMILY} children. Remove one before adding
              another.
            </p>
          ) : null}
          {error && !editingId ? (
            <p role="alert" className="mt-3 mb-0 text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
