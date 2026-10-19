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
    expect(content).toContain('Wild animals are watched, never touched')
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

describe('issue #66: quotes the ladder could not place on 2026-10-17', () => {
  const hard = (rule: number, quote: string): OutputViolation => ({ rule, quote, severity: 'hard' })

  it('a quote from a true fact is placed there, and the cut drops that fact while the story keeps its minimum', () => {
    const story = goodStory()
    story.true_facts.push({ text: 'On **January 27, 1967**, a fire during a ground test killed three astronauts.', fact_id: 'f99' })
    const v = hard(2, 'On January 27, 1967, a fire during a ground test killed three astronauts')
    expect(locateViolation(story, v)).toMatchObject({ part: 'true_fact', chapter: story.true_facts.length - 1 })
    const cut = cutViolations(story, [v])
    expect(cut.complete).toBe(true)
    expect(cut.story.true_facts.map((f) => f.fact_id)).not.toContain('f99')
    expect(cut.story.chapters).toEqual(story.chapters)
    // At the minimum, a fact cannot go: not complete, so the story is not shipped with it.
    const atMin = { ...story, true_facts: story.true_facts.slice(-8) }
    expect(cutViolations(atMin, [v]).complete).toBe(false)
  })

  it('the subtitle and a shout line go; the ending line and a heading become plain words, never invented ones', () => {
    const story = goodStory()
    story.subtitle = 'A sleep-science adventure for a kid who should really be asleep by now'
    story.ending_line = 'Goodnight, Phoenix. Goodnight, Cruz. Print well.'
    story.chapters[2]!.heading = 'The Glitch at Midnight'
    story.chapters[3]!.shout_line = 'Hold on tight to the wild dolphin!'
    const vs = [
      hard(12, story.subtitle),
      hard(12, story.ending_line),
      hard(3, 'The Glitch at Midnight'),
      hard(10, 'Hold on tight to the wild dolphin!'),
    ]
    const cut = cutViolations(story, vs)
    expect(cut.complete).toBe(true)
    expect(cut.story.subtitle).toBeNull()
    expect(cut.story.ending_line).toBe('The end.')
    expect(cut.story.chapters[2]!.heading).toBe('Chapter 3')
    expect(cut.story.chapters[3]!.shout_line).toBeNull()
    expect(cut.story.chapters.map((c) => c.text)).toEqual(story.chapters.map((c) => c.text))
  })

  it('the mend model is sent chapter sentences only', async () => {
    const story = goodStory()
    story.ending_line = 'Goodnight, Phoenix. Goodnight, Cruz. Print well.'
    const result = await mendStory(story, [hard(12, story.ending_line)])
    expect(calls.made).toHaveLength(0)
    expect(result.edits).toBe(0)
  })

  it("a reviewer quote with the rule's own words glued on, or a sentence the mend already changed, is placed by a run unique to the story", () => {
    const flipper = 'Maya grinned and grabbed his flipper. "All aboard!"'
    const story = storyWith([KEEP, flipper])
    const glued = hard(10, 'A child touching, patting, stroking, feeding or riding a wild animal is a breach... Maya grabbed his flipper.')
    expect(locateViolation(story, glued)).toMatchObject({ chapter: 1, text: 'Maya grinned and grabbed his flipper.' })
    expect(cutViolations(story, [glued]).complete).toBe(true)
  })

  it('a three-word run that is not unique to the story places nothing', () => {
    const story = storyWith(['Maya grabbed his hat and ran.', 'Then Maya grabbed his scarf too.'])
    expect(locateViolation(story, hard(10, 'Maya grabbed his flipper.'))).toBeNull()
  })

  it("matches through markdown bold and curly quotes", () => {
    const story = storyWith([KEEP, 'Juno said, “It’s **huge**,” and patted the whale shark.'])
    const where = locateViolation(story, hard(10, `Juno said, "It's huge," and patted the whale shark.`))
    expect(where?.text).toBe('Juno said, “It’s **huge**,” and patted the whale shark.')
  })

  it("a scanner window is placed on the hit, not on the harmless sentences beside it", () => {
    const story = goodStory()
    story.chapters[1]!.text = `"Mermaids belong in water," Ellie announced, stepping in right behind him.\n\nThe bubble swallowed them both. WHOOOOSH.`
    story.chapters[1]!.shout_line = "LET'S DIVE!"
    const window = `….\n\n"Mermaids belong in water," Ellie announced, stepping in right behind him.\n\nThe bubble swallowed them both. WHOOOOSH.\n\nLET'S DIVE!\n\nC…`
    const where = locateViolation(story, hard(3, window))
    expect(where?.text).toBe('"Mermaids belong in water," Ellie announced, stepping in right behind him.')
  })

  // From /code-review on PR #67.
  it('glued rule text does not win: the run covering most of its own sentence is placed', () => {
    const story = storyWith([KEEP, 'Maya grinned and grabbed his flipper.'])
    story.true_facts.push({ text: 'Never feed a wild animal in the sea.', fact_id: 'f98' })
    const glued = hard(10, 'A child touching, patting, stroking, feeding or riding a wild animal is a breach... Maya grabbed his flipper.')
    expect(locateViolation(story, glued)).toMatchObject({ chapter: 1, text: 'Maya grinned and grabbed his flipper.' })
  })

  it('a run matches whole words only: "he was so" is not inside "she was so"', () => {
    const story = storyWith(['Mia said she was so happy to see the sea.'])
    expect(locateViolation(story, hard(3, 'and he was so frightened'))).toBeNull()
  })

  it('a scanner window is placed on its flagged piece, never on a neighbour by a run', () => {
    const story = storyWith(['The boat rocked gently on the bay.', 'Juno patted the whale shark.', 'Ellie laughed at the waves below.'])
    const window = '…oat rocked gently on the bay. Juno patted the whale shark. Ellie laughed at the wav…'
    expect(locateViolation(story, hard(10, window))?.text).toBe('Juno patted the whale shark.')
  })

  it("a reviewer quote trimmed with '...' on a rule the scanner does not cover is still placed by a run (PR #67 review)", () => {
    const story = storyWith([KEEP, 'Theo held up his picture and everyone giggled at his tiny drawing.'])
    // Stale and trimmed: the reviewer's wording, not the text's; rule 13 has no scanner phrase here.
    const v = hard(13, '...and everyone giggled at his tiny drawing again')
    expect(locateViolation(story, v)?.text).toBe('Theo held up his picture and everyone giggled at his tiny drawing.')
  })

  it('a flagged title is placed and replaced with plain words', () => {
    const story = goodStory()
    story.title = 'The Day Theo Rode the Wild Dolphin'
    const v = hard(10, 'The Day Theo Rode the Wild Dolphin')
    expect(locateViolation(story, v)).toMatchObject({ part: 'title' })
    expect(cutViolations(story, [v]).story.title).toBe('A Bedtime Story')
  })

  it('a run ending at "Mr." does not end the passage mid-sentence', () => {
    const story = storyWith([KEEP, 'Juno waved at Mr. Shark and patted his fin.'])
    const where = locateViolation(story, hard(10, 'and then Juno waved at Mr.'))
    expect(where?.text).toBe('Juno waved at Mr. Shark and patted his fin.')
  })

  it('invisible characters and stray tags in the story do not stop a match', () => {
    const story = storyWith([KEEP, 'Juno reached out and \u200bpatted the <em>whale shark</em>.'])
    const where = locateViolation(story, hard(10, 'Juno reached out and patted the whale shark.'))
    expect(where?.chapter).toBe(1)
  })
})
