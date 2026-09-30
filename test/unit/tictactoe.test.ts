import { describe, expect, it } from 'vitest'
import {
  current,
  EMPTY_BOARD,
  HOUSE_NAME,
  houseMove,
  move,
  newMatch,
  nextRound,
  outcome,
  play,
  statusLine,
  type Board,
} from '@/lib/client/tictactoe'

/** Tic-tac-toe while the story is written (DECISIONS #142): the rules, pinned. */

const board = (s: string): Board => [...s.replace(/\s/g, '')].map((c) => (c === '.' ? null : (c as 'X' | 'O')))

describe('outcome', () => {
  it('finds rows, columns and diagonals, and reports the winning line', () => {
    expect(outcome(board('XXX......')).line).toEqual([0, 1, 2])
    expect(outcome(board('O..O..O..')).winner).toBe('O')
    expect(outcome(board('X...X...X')).line).toEqual([0, 4, 8])
    expect(outcome(board('..X.X.X..')).winner).toBe('X')
  })
  it('knows a draw from a game in progress', () => {
    expect(outcome(board('XOXXOOOXX'))).toMatchObject({ winner: null, draw: true, over: true })
    expect(outcome(board('XO.......'))).toMatchObject({ winner: null, draw: false, over: false })
  })
})

describe('play', () => {
  it('refuses a taken cell and any move after the game is over', () => {
    const b = play(EMPTY_BOARD, 4, 'X')
    expect(play(b, 4, 'O')).toBe(b)
    const won = board('XXX.OO...')
    expect(play(won, 8, 'O')).toBe(won)
  })
})

describe('the house opponent', () => {
  it('takes a win when it has one', () => {
    expect(houseMove(board('OO.XX....'), 'O')).toBe(2)
  })
  it('blocks a win it does not have', () => {
    expect(houseMove(board('XX..O....'), 'O')).toBe(2)
  })
  it('prefers the centre, then a corner, and never a taken cell', () => {
    expect(houseMove(board('X........'), 'O')).toBe(4)
    const corner = houseMove(board('X...O....'), 'O', () => 0)
    expect([2, 6, 8]).toContain(corner)
  })
})

describe('a match between children', () => {
  it('names the two children, X first; a third child waits on the bench', () => {
    const m = newMatch(['Milo', 'Juno', 'Theo'])
    expect(m.players.map((p) => p.name)).toEqual(['Milo', 'Juno'])
    expect(m.bench).toEqual(['Theo'])
    expect(statusLine(m)).toBe("Milo's turn")
  })
  it('alternates turns, scores the winner and says so', () => {
    let m = newMatch(['Milo', 'Juno'])
    for (const i of [0, 3, 1, 4, 2]) m = move(m, i) // Milo takes the top row
    expect(outcome(m.board).winner).toBe('X')
    expect(statusLine(m)).toBe('Milo wins!')
    expect(m.wins).toEqual({ Milo: 1 })
    expect(move(m, 8)).toBe(m) // the round is over
  })
  it('next round: the loser gives up the seat to the bench, and X always starts', () => {
    let m = newMatch(['Milo', 'Juno', 'Theo'])
    for (const i of [0, 3, 1, 4, 2]) m = move(m, i)
    m = nextRound(m)
    expect(m.players.map((p) => `${p.name}:${p.mark}`)).toEqual(['Milo:X', 'Theo:O'])
    expect(m.bench).toEqual(['Juno'])
    expect(m.round).toBe(2)
    expect(current(m).name).toBe('Milo')
  })
  it('next round with two players swaps who goes first', () => {
    let m = newMatch(['Milo', 'Juno'])
    for (const i of [0, 3, 1, 4, 2]) m = move(m, i)
    m = nextRound(m)
    expect(m.players.map((p) => `${p.name}:${p.mark}`)).toEqual(['Juno:X', 'Milo:O'])
  })
})

describe('one child against the house', () => {
  it('the child is X and always opens; the house is named', () => {
    const m = newMatch(['Milo'])
    expect(m.players[0]).toMatchObject({ name: 'Milo', mark: 'X', house: false })
    expect(m.players[1]).toMatchObject({ name: HOUSE_NAME, mark: 'O', house: true })
    let played = m
    for (const i of [0, 3, 1, 4, 2]) played = move(played, i)
    expect(nextRound(played).players[0]!.name).toBe('Milo')
  })
})
