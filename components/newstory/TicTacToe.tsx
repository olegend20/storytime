'use client'

import { useEffect, useState } from 'react'
import {
  current,
  houseMove,
  move,
  newMatch,
  nextRound,
  outcome,
  statusLine,
  type Match,
} from '@/lib/client/tictactoe'

/**
 * Tic-tac-toe while the story is written (DECISIONS #142). Two children play each other by
 * name; one child plays StoryTime. Appears the instant the story is requested and hands
 * over to the reader when the title arrives.
 */

export const HOUSE_DELAY_MS = 500

export interface TicTacToeProps {
  /** First names of the selected children; the first two play, the rest wait their turn. */
  names: string[]
  /** What the writer is doing right now, shown under the board. */
  status: string
  onCancel?: () => void
  /** Test seam: the house moves at once. */
  houseDelayMs?: number
}

export function TicTacToe({ names, status, onCancel, houseDelayMs = HOUSE_DELAY_MS }: TicTacToeProps) {
  const [match, setMatch] = useState<Match>(() => newMatch(names))
  const result = outcome(match.board)
  const player = current(match)

  // The house takes its turn by itself, after a beat, so it reads as a turn and not a trick.
  useEffect(() => {
    if (result.over || !player.house) return
    const timer = setTimeout(() => {
      setMatch((m) => (current(m).house && !outcome(m.board).over ? move(m, houseMove(m.board, current(m).mark)) : m))
    }, houseDelayMs)
    return () => clearTimeout(timer)
  }, [match, player.house, result.over, houseDelayMs])

  const [x, o] = match.players
  const score = (name: string) => match.wins[name] ?? 0

  return (
    <section className="mx-auto max-w-md px-4 py-6" aria-labelledby="ttt-heading" data-testid="tictactoe">
      <p className="mt-0 mb-1 text-sm" style={{ color: 'var(--fg-muted)' }} data-testid="story-status">
        {status}
      </p>
      <h2 id="ttt-heading" className="mt-0 mb-3 text-[clamp(1.4rem,4.5vw,2rem)]">
        {x.name} <span aria-hidden="true">✕</span> vs {o.name} <span aria-hidden="true">◯</span>
      </h2>

      <div
        className="grid grid-cols-3 gap-2"
        role="group"
        aria-label="Tic-tac-toe board"
        data-testid="ttt-board"
      >
        {match.board.map((cell, i) => {
          const row = Math.floor(i / 3) + 1
          const col = (i % 3) + 1
          const inLine = result.line?.includes(i) ?? false
          const label = `Row ${row}, column ${col}: ${cell === 'X' ? x.name : cell === 'O' ? o.name : 'empty'}`
          return (
            <button
              key={i}
              type="button"
              aria-label={label}
              data-testid={`ttt-cell-${i}`}
              data-mark={cell ?? ''}
              disabled={cell !== null || result.over || player.house}
              onClick={() => setMatch((m) => move(m, i))}
              className="card ttt-cell flex aspect-square items-center justify-center text-[clamp(2.4rem,12vw,4rem)] font-bold"
              style={{
                color: cell === 'X' ? 'var(--accent)' : cell === 'O' ? 'var(--accent-warm)' : 'var(--fg)',
                background: inLine ? 'var(--accent-soft)' : undefined,
                borderColor: inLine ? 'var(--accent)' : undefined,
                cursor: cell === null && !result.over && !player.house ? 'pointer' : 'default',
              }}
            >
              {cell === 'X' ? '✕' : cell === 'O' ? '◯' : ''}
            </button>
          )
        })}
      </div>

      <p className="mt-4 mb-2 text-center text-xl font-semibold" aria-live="polite" data-testid="ttt-status">
        {statusLine(match)}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm" style={{ color: 'var(--fg-muted)' }} data-testid="ttt-score">
          Round {match.round} · {x.name} {score(x.name)} – {score(o.name)} {o.name}
          {match.bench.length > 0 ? ` · next up: ${match.bench[0]}` : ''}
        </p>
        {result.over ? (
          <button type="button" className="btn" onClick={() => setMatch((m) => nextRound(m))}>
            Play again
          </button>
        ) : null}
      </div>

      {onCancel ? (
        <button type="button" className="btn btn-quiet mt-6" onClick={onCancel}>
          Change the topic
        </button>
      ) : null}
    </section>
  )
}
