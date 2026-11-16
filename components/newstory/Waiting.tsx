import { useEffect, useState } from 'react'
import { Check } from '@/components/Icons'
import { Phase } from '@/components/Phase'
import { joinNames } from '@/lib/client/reader'
import { GROWN_UP_AFTER_MS, GROWN_UP_LINE, thankfulQuestion } from '@/lib/waiting'

/**
 * Waiting for the writer, quietly (issue #17; replaces the tic-tac-toe of DECISIONS #142).
 *
 * The moon and the two lines show the stage the server has actually reached - facts first,
 * then writing once the `facts` event arrives. There is no countdown and no percentage,
 * because nobody knows how long a story takes and bedtime is no place to pretend.
 *
 * The topic is only shown once the server has sent its own label for it: until then the
 * parent's words have not been accepted, and we never show back a topic that may be refused.
 *
 * Below the stages, one question for the family to answer out loud (issue #112): the children
 * first, then the grown-up. Nothing to tap and nothing kept - it is a wind-down, not a game.
 */
export function Waiting({
  names,
  topicLabel,
  stage,
  onCancel,
}: {
  names: readonly string[]
  /** The server's label for the topic, from the `facts` event; null before it arrives. */
  topicLabel: string | null
  stage: 'facts' | 'writing'
  /** Absent while the page waits for a story the server is still finishing (issue #59). */
  onCancel?: () => void
}) {
  const who = joinNames(names)
  const [askGrownUp, setAskGrownUp] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setAskGrownUp(true), GROWN_UP_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <section className="st-waiting" data-testid="waiting">
      <Phase lit={stage === 'facts' ? 0.22 : 0.62} size={46} className="st-waiting-moon" />
      <p className="st-eyebrow">Tonight’s little adventure</p>
      <h1 className="st-h1 st-h1-center">A little wonder is on its way.</h1>
      <ol className="st-stages" aria-live="polite" data-testid="story-status">
        <li data-state={stage === 'facts' ? 'active' : 'done'}>
          <span className="st-stage-dot" aria-hidden>
            {stage !== 'facts' ? <Check width={12} height={12} /> : null}
          </span>
          Getting the facts ready for your story
          {stage !== 'facts' ? <span className="sr-only-text"> (done)</span> : null}
        </li>
        <li data-state={stage === 'writing' ? 'active' : 'pending'}>
          <span className="st-stage-dot" aria-hidden />
          Writing your story
        </li>
      </ol>
      <p className="st-waiting-help">You can start reading as soon as the first words arrive.</p>
      <div className="st-thankful" data-testid="thankful">
        <p className="st-thankful-eyebrow">While we wait…</p>
        <p className="st-thankful-question">{thankfulQuestion(names)}</p>
        <p className="st-thankful-grownup" aria-live="polite">
          {askGrownUp ? <span className="st-fade-in">{GROWN_UP_LINE}</span> : null}
        </p>
      </div>
      <i className="st-rule" aria-hidden />
      {who ? (
        <p className="st-waiting-for">
          <strong>For {who}</strong>
          {topicLabel ? ` · About ${topicLabel}` : ''}
        </p>
      ) : null}
      {onCancel ? (
        <button type="button" className="st-textlink" onClick={onCancel}>
          Back to tonight’s book
        </button>
      ) : null}
    </section>
  )
}
