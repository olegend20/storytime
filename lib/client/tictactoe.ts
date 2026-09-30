/**
 * Tic-tac-toe, for the two minutes the writer thinks (DECISIONS #142).
 *
 * Pure logic, no React: the board is nine cells, the players are the selected children by
 * name (or one child against "StoryTime"), and every rule a test needs to pin lives here.
 */

export type Mark = 'X' | 'O'
export type Cell = Mark | null
export type Board = readonly Cell[]

export const EMPTY_BOARD: Board = Array.from({ length: 9 }, () => null)

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
]

export interface Outcome {
  winner: Mark | null
  /** The three cells that won, for highlighting. */
  line: readonly [number, number, number] | null
  draw: boolean
  over: boolean
}

export function outcome(board: Board): Outcome {
  for (const line of LINES) {
    const [a, b, c] = line
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a]!, line, draw: false, over: true }
    }
  }
  const full = board.every((c) => c !== null)
  return { winner: null, line: null, draw: full, over: full }
}

export function play(board: Board, index: number, mark: Mark): Board {
  if (board[index] !== null || outcome(board).over) return board
  const next = [...board]
  next[index] = mark
  return next
}

export const other = (mark: Mark): Mark => (mark === 'X' ? 'O' : 'X')

/**
 * The house opponent: takes a win, blocks a win, otherwise the centre, a corner, anywhere.
 * Beatable on purpose - a four-year-old should win sometimes - but never careless.
 */
export function houseMove(board: Board, mark: Mark, random: () => number = Math.random): number {
  const empty = board.map((c, i) => (c === null ? i : -1)).filter((i) => i >= 0)
  const wins = (m: Mark) => empty.find((i) => outcome(play(board, i, m)).winner === m)
  const win = wins(mark)
  if (win !== undefined) return win
  const block = wins(other(mark))
  if (block !== undefined) return block
  if (empty.includes(4)) return 4
  const corners = empty.filter((i) => [0, 2, 6, 8].includes(i))
  const pool = corners.length > 0 ? corners : empty
  return pool[Math.floor(random() * pool.length)]!
}

export const HOUSE_NAME = 'StoryTime'

export interface Player {
  name: string
  mark: Mark
  /** True for the house opponent, which moves by itself. */
  house: boolean
}

export interface Match {
  players: readonly [Player, Player]
  /** Children waiting to play the winner next round (three or more selected). */
  bench: readonly string[]
  board: Board
  /** Whose turn: index into `players`. */
  turn: 0 | 1
  round: number
  wins: Record<string, number>
}

/** A fresh match: two children by name, or one child against the house. */
export function newMatch(names: readonly string[]): Match {
  const [first, second, ...rest] = names.filter((n) => n.trim() !== '')
  const players: [Player, Player] = [
    { name: first ?? 'You', mark: 'X', house: false },
    second ? { name: second, mark: 'O', house: false } : { name: HOUSE_NAME, mark: 'O', house: true },
  ]
  return { players, bench: rest, board: EMPTY_BOARD, turn: 0, round: 1, wins: {} }
}

export function current(match: Match): Player {
  return match.players[match.turn]
}

/** A move by whoever's turn it is. Ignored if the cell is taken or the round is over. */
export function move(match: Match, index: number): Match {
  const player = current(match)
  const board = play(match.board, index, player.mark)
  if (board === match.board) return match
  const result = outcome(board)
  const wins = { ...match.wins }
  if (result.winner) wins[player.name] = (wins[player.name] ?? 0) + 1
  return { ...match, board, wins, turn: result.over ? match.turn : ((match.turn + 1) % 2) as 0 | 1 }
}

/**
 * The next round. X always starts, and the loser gives up the seat to the next child on the
 * bench (a draw benches O). With two players the seats simply swap marks, so the child who
 * went second gets to go first.
 */
export function nextRound(match: Match): Match {
  const result = outcome(match.board)
  const [a, b] = match.players
  let players: [Player, Player]
  const bench = [...match.bench]
  if (bench.length > 0 && !a.house && !b.house) {
    const loser = result.winner ? (result.winner === a.mark ? b : a) : b
    const stays = loser === a ? b : a
    const incoming: Player = { name: bench.shift()!, mark: 'O', house: false }
    bench.push(loser.name)
    players = [{ ...stays, mark: 'X' }, incoming]
  } else {
    players = [{ ...b, mark: 'X' }, { ...a, mark: 'O' }]
    // The house never goes first: a child should always open.
    if (players[0].house) players = [{ ...a, mark: 'X' }, { ...b, mark: 'O' }]
  }
  return { ...match, players, bench, board: EMPTY_BOARD, turn: 0, round: match.round + 1 }
}

/** The line under the board: whose turn, who won, or a draw. */
export function statusLine(match: Match): string {
  const result = outcome(match.board)
  if (result.winner) {
    const winner = match.players.find((p) => p.mark === result.winner)!
    return winner.house ? `${HOUSE_NAME} wins this one!` : `${winner.name} wins!`
  }
  if (result.draw) return "It's a draw!"
  const p = current(match)
  return p.house ? `${HOUSE_NAME} is thinking…` : `${p.name}'s turn`
}
