'use client'

import { useState } from 'react'
import { ArrowRight } from '@/components/Icons'
import { FEEDBACK_COPY as copy, MAX_NAME, MAX_TEXT, QUESTIONS } from '@/lib/feedback/questions'

/**
 * The tester feedback form. Every question is optional; the server needs at least one answer
 * and checks every value against the same list (lib/feedback/questions.ts). On success the
 * form is replaced by a thank-you.
 *
 * `website` is a honeypot, as on the waitlist form: hidden from people and screen readers.
 */
type Answers = Record<string, string | string[]>

export default function FeedbackForm() {
  const [answers, setAnswers] = useState<Answers>({})
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [website, setWebsite] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  const set = (key: string, value: string | string[]) => setAnswers((a) => ({ ...a, [key]: value }))
  const toggle = (key: string, value: string) => {
    const now = Array.isArray(answers[key]) ? (answers[key] as string[]) : []
    set(key, now.includes(value) ? now.filter((v) => v !== value) : [...now, value])
  }

  async function send(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setStatus('sending')
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...answers, name, email, website }),
      })
      if (response.ok) return setStatus('done')
      const body = (await response.json().catch(() => null)) as { message?: string } | null
      setStatus('idle')
      setError(response.status === 400 && body?.message ? body.message : copy.error)
    } catch {
      setStatus('idle')
      setError(copy.error)
    }
  }

  if (status === 'done') {
    return (
      <>
        <h1 className="lt-h1">{copy.doneTitle}</h1>
        <p className="lt-lead" role="status">
          {copy.doneBody}
        </p>
      </>
    )
  }

  return (
    <>
      <h1 className="lt-h1">{copy.title}</h1>
      <p className="lt-lead">{copy.lead}</p>
      <form className="fb-form" onSubmit={send} noValidate>
        <p className="fb-note">{copy.childNote}</p>
        {QUESTIONS.map((q) => {
          if (q.kind === 'text') {
            const id = `fb-${q.key}`
            return (
              <div key={q.key} className="fb-q">
                <label htmlFor={id} className="fb-label">
                  {q.label}
                </label>
                {q.hint ? (
                  <p id={`${id}-hint`} className="fb-hint">
                    {q.hint}
                  </p>
                ) : null}
                <textarea
                  id={id}
                  name={q.key}
                  className="field fb-text"
                  maxLength={MAX_TEXT}
                  aria-describedby={q.hint ? `${id}-hint` : undefined}
                  value={typeof answers[q.key] === 'string' ? (answers[q.key] as string) : ''}
                  onChange={(e) => set(q.key, e.target.value)}
                />
              </div>
            )
          }
          const many = q.kind === 'many'
          return (
            <fieldset key={q.key} className="fb-q">
              <legend>{q.label}</legend>
              <div className="fb-choices">
                {q.choices.map((c) => {
                  const current = answers[q.key]
                  const checked = many
                    ? Array.isArray(current) && current.includes(c.value)
                    : current === c.value
                  return (
                    <label key={c.value} className="fb-choice">
                      <input
                        type={many ? 'checkbox' : 'radio'}
                        name={q.key}
                        value={c.value}
                        checked={checked}
                        onChange={() => (many ? toggle(q.key, c.value) : set(q.key, c.value))}
                      />
                      {c.label}
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )
        })}

        <div className="fb-about">
          <div>
            <label htmlFor="fb-name" className="fb-label">
              {copy.nameLabel}
            </label>
            <input
              id="fb-name"
              name="name"
              type="text"
              autoComplete="name"
              maxLength={MAX_NAME}
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="fb-email" className="fb-label">
              {copy.emailLabel}
            </label>
            <input
              id="fb-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              className="field"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>

        <div className="lt-hp" aria-hidden="true">
          <label htmlFor="fb-website">Website</label>
          <input
            id="fb-website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>

        {error ? (
          <p role="alert" className="fb-error">
            {error}
          </p>
        ) : null}

        <button type="submit" className="st-primary lt-primary fb-send" disabled={status === 'sending'}>
          {status === 'sending' ? copy.sending : copy.send} <ArrowRight />
        </button>
      </form>
    </>
  )
}
