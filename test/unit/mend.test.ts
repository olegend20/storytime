import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Issue #32, rungs 1 and 2 (VT-D2, VT-D3 at the unit level). The gate knows the rule and
 * the quote; the mend changes only the sentences that hold the quote, and the cut removes
 * them. Everything else stays byte-identical.
 */

const calls = vi.hoisted(() => ({ made: [] as Record<string, unknown>[], reply: '' }))

vi.mock('@/lib/ai', async (orig) => {
  const actual = await orig<typeof import('@/lib/ai')>()
  return {
    ...actual,
    callModel: async (opts: Record<string, unknown>) => {
      calls.made.push(opts)
      return {
        text: calls.reply,
        data: null,
        usage: { input_tokens: 900, output_tokens: 120, cache_read_tokens: 0, cache_write_tokens: 0 },
        costUsd: 0.004,
        latencyMs: 2_000,
        model: 'claude-haiku-4-5-20251001',
        stopReason: 'end_turn',
        replayed: false,
        raw: { content: [{ type: 'text', text: calls.reply }] },
      }
    },
  }
})

const { cutViolations, locateViolation, mendStory, mendUserMessage, passagesFor } = await import('@/lib/generate/mend')
const { goodStory } = await import('../helpers/story')
import type { OutputViolation, StoryOutput } from '@/lib/schemas'

afterEach(() => {
  calls.made.length = 0
  calls.reply = ''
})

function storyWith(sentences: string[]): StoryOutput {
  const story = goodStory()
  story.chapters[1]!.text = sentences.join(' ')
  return story
}

const ELSA = 'Then Elsa waved her hand and the pond froze solid.'
const PATS = 'Juno reached out and patted the whale shark, soft as a pool float.'
const KEEP = 'Milo counted the rows of teeth, one, two, three, so many.'

describe('locating a violation', () => {
  it('finds the whole sentence holding a reviewer quote, in the right chapter', () => {
    const story = storyWith([KEEP, PATS, ELSA])
    const where = locateViolation(story, { rule: 10, quote: 'patted the whale shark', severity: 'hard' })
    expect(where).toMatchObject({ chapter: 1, text: PATS, rule: 10 })
  })

  it('finds the scanner\'s windowed quote (with its ellipses and context) the same way', () => {
    const story = storyWith([KEEP, ELSA, PATS])
    const windowed = `…${KEEP.slice(-20)} ${ELSA} ${PATS.slice(0, 15)}…`
    const where = locateViolation(story, { rule: 7, quote: windowed, severity: 'hard' })
    expect(where?.chapter).toBe(1)
    expect(where?.text).toContain(ELSA)
  })

  it('a passage is a raw slice of the chapter: paragraph breaks and newlines inside sentences survive', () => {
    const story = goodStory()
    story.chapters[1]!.text = `${KEEP}\n\n${ELSA}\n${PATS}\n\nThe end of the chapter.`
    // A scanner window straddling the paragraph break.
    const windowed = `…${KEEP.slice(-25)}\n\n${ELSA.slice(0, 30)}…`
    const where = locateViolation(story, { rule: 7, quote: windowed, severity: 'hard' })!
    expect(story.chapters[1]!.text.slice(where.start, where.start + where.text.length)).toBe(where.text)
    expect(where.text).toContain(ELSA)
    // A sentence that holds a newline is still one sentence.
    const sign = 'The sign read:\nNO SWIMMING, said Juno.'
    story.chapters[1]!.text = `${KEEP} ${sign} Then she jumped in anyway.`
    const jump = locateViolation(story, { rule: 10, quote: 'NO SWIMMING, said Juno', severity: 'hard' })!
    expect(jump.text).toBe(sign)
    expect(cutViolations(story, [{ rule: 10, quote: 'NO SWIMMING, said Juno', severity: 'hard' }]).story.chapters[1]!.text).toBe(`${KEEP} Then she jumped in anyway.`)
  })

  it('a paraphrased quote is placed by its longest run of words the text has', () => {
    const story = storyWith([KEEP, PATS])
    const where = locateViolation(story, { rule: 10, quote: 'Juno reached out and patted the whale shark happily', severity: 'hard' })
    expect(where?.text).toBe(PATS)
  })

  it('a paraphrase made of common words is not placed on a harmless sentence', () => {
    const story = storyWith(['And the boys were very tired after the long walk home.', 'And the boys were splashing in the deep water alone.'])
    // "and the boys were" occurs twice; nothing longer and unique matches: not placed.
    expect(locateViolation(story, { rule: 10, quote: 'and the boys were happy', severity: 'hard' })).toBeNull()
  })

  it('returns null for a quote the story does not have, and skips soft violations', () => {
    const story = storyWith([KEEP])
    expect(locateViolation(story, { rule: 3, quote: 'it was right behind him', severity: 'hard' })).toBeNull()
    expect(passagesFor(story, [{ rule: 7, quote: KEEP, severity: 'soft' }])).toEqual({ passages: [], unlocated: [] })
    expect(passagesFor(story, [{ rule: 3, quote: 'it was right behind him', severity: 'hard' }]).unlocated).toHaveLength(1)
  })
})

describe('rung 1: the mend', () => {
  const violations: OutputViolation[] = [
    { rule: 7, quote: 'Elsa waved her hand', severity: 'hard' },
    { rule: 10, quote: 'patted the whale shark', severity: 'hard' },
  ]

  it('rewrites only the sentences it was given, and leaves the rest byte-identical', async () => {
    const story = storyWith([KEEP, ELSA, PATS])
    const before = JSON.stringify(story)
    calls.reply = JSON.stringify({
      edits: [
        { chapter: 1, find: ELSA, replace: 'Milo pictured Elsa from the film, and the pond glittered.' },
        { chapter: 1, find: PATS, replace: 'Juno waved at the whale shark from the raft. "We just look," said Splash.' },
      ],
    })
    const result = await mendStory(story, violations)
    expect(result.edits).toBe(2)
    expect(result.passages).toBe(2)
    expect(result.story.chapters[1]!.text).toBe(
      [KEEP, 'Milo pictured Elsa from the film, and the pond glittered.', 'Juno waved at the whale shark from the raft. "We just look," said Splash.'].join(' '),
    )
    // Nothing else moved.
    expect(JSON.stringify({ ...result.story, chapters: result.story.chapters.map((c, i) => (i === 1 ? story.chapters[1] : c)) })).toBe(before)
    // One helper call, named for what it is, with the rules and the passages as data.
    expect(calls.made).toHaveLength(1)
    expect(calls.made[0]!.purpose).toBe('mend')
    expect(calls.made[0]!.role).toBe('helper')
    const content = (calls.made[0]!.messages as { content: string }[])[0]!.content
    expect(content).toBe(mendUserMessage(passagesFor(story, violations).passages))
    expect(content).toContain('<passages>')
    expect(content).toContain('7. No branded fictional characters')
  })

  it('applies no edit it did not ask for, none it cannot place, none that balloons, and each passage once', async () => {
    const story = storyWith([KEEP, ELSA])
    calls.reply = JSON.stringify({
      edits: [
        { chapter: 1, find: KEEP, replace: 'Milo did something else.' }, // not a passage
        { chapter: 0, find: ELSA, replace: 'wrong chapter' },
        { chapter: 1, find: ELSA, replace: 'A'.repeat(ELSA.length * 3 + 201) }, // balloons
        { chapter: 1, find: 'Then Elsa waved', replace: 'x' }, // inside the passage: applied
        { chapter: 1, find: 'pond froze solid', replace: 'y' }, // same passage again: not applied
      ],
    })
    const result = await mendStory(story, [{ rule: 7, quote: ELSA, severity: 'hard' }])
    expect(result.edits).toBe(1)
    expect(result.story.chapters[1]!.text).toBe(`${KEEP} x her hand and the pond froze solid.`)
    expect(result.story.chapters[0]!.text).toBe(story.chapters[0]!.text)
  })

  it('a shorter earlier edit does not lose a later passage in the same chapter', async () => {
    const story = storyWith([KEEP, ELSA, PATS])
    calls.reply = JSON.stringify({
      edits: [
        { chapter: 1, find: ELSA, replace: 'x' },
        { chapter: 1, find: PATS, replace: 'Juno waved from the raft.' },
      ],
    })
    const result = await mendStory(story, [
      { rule: 7, quote: 'Elsa waved her hand', severity: 'hard' },
      { rule: 10, quote: 'patted the whale shark', severity: 'hard' },
    ])
    expect(result.edits).toBe(2)
    expect(result.story.chapters[1]!.text).toBe(`${KEEP} x Juno waved from the raft.`)
  })

  it('a short find edits the passage, never an earlier look-alike in the chapter', async () => {
    const earlier = 'Juno reached out for the torch.'
    const story = storyWith([earlier, KEEP, PATS])
    calls.reply = JSON.stringify({ edits: [{ chapter: 1, find: 'Juno reached out', replace: 'Juno looked out' }] })
    const result = await mendStory(story, [{ rule: 10, quote: 'patted the whale shark', severity: 'hard' }])
    expect(result.edits).toBe(1)
    expect(result.story.chapters[1]!.text).toBe([earlier, KEEP, PATS.replace('Juno reached out', 'Juno looked out')].join(' '))
  })

  it('makes no call when nothing can be located', async () => {
    const story = storyWith([KEEP])
    const result = await mendStory(story, [{ rule: 3, quote: 'it was right behind him', severity: 'hard' }])
    expect(result).toMatchObject({ edits: 0, passages: 0, costUsd: 0 })
    expect(calls.made).toHaveLength(0)
  })

  it('survives an unparseable reply with the story unchanged', async () => {
    const story = storyWith([KEEP, ELSA])
    calls.reply = 'I would rather not.'
    const result = await mendStory(story, [{ rule: 7, quote: ELSA, severity: 'hard' }])
    expect(result.edits).toBe(0)
    expect(result.story).toEqual(story)
  })
})

describe('rung 2: the cut', () => {
  it('removes the sentences holding the quotes and tidies the gap', () => {
    const story = storyWith([KEEP, ELSA, PATS])
    const { story: cut, cut: n, complete } = cutViolations(story, [
      { rule: 7, quote: 'Elsa waved her hand', severity: 'hard' },
      { rule: 10, quote: 'patted the whale shark', severity: 'hard' },
    ])
    expect(n).toBe(2)
    expect(complete).toBe(true)
    expect(cut.chapters[1]!.text).toBe(KEEP)
    expect(cut.chapters[0]).toEqual(story.chapters[0])
  })

  it('is not complete when any hard violation could not be placed: a breach must never stay in', () => {
    const story = storyWith([KEEP, ELSA])
    const result = cutViolations(story, [
      { rule: 7, quote: 'Elsa waved her hand', severity: 'hard' },
      { rule: 2, quote: 'a paraphrase the text does not contain', severity: 'hard' },
    ])
    expect(result.cut).toBe(1)
    expect(result.complete).toBe(false)
  })

  it('never empties a chapter', () => {
    const story = storyWith([ELSA])
    const { story: cut, cut: n } = cutViolations(story, [{ rule: 7, quote: ELSA, severity: 'hard' }])
    expect(n).toBe(0)
    expect(cut).toEqual(story)
  })
})
