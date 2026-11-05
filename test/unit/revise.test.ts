import { describe, expect, it } from 'vitest'
import { applyRevisions, problemsFor, reviseInRounds, REVISE_MAX_EDITS, REVISE_MAX_ROUNDS, type ReviseEdit, type ReviseResult } from '@/lib/generate/revise'
import type { QualityResult } from '@/lib/schemas'
import { goodStory } from '../helpers/story'

/**
 * Issue #85 (VT-FR3): an in-place revision changes only what it may. Title, subtitle and
 * headings are not addressable; an edit whose `find` is missing or not unique is dropped; the
 * total replaced is capped; True Facts never drop below the minimum.
 */

const story = goodStory()
const first = 'Chapter 1 began with a sound nobody expected.'

function edit(over: Partial<ReviseEdit>): ReviseEdit {
  return { part: 'chapter', index: 0, find: first, replace: 'Chapter 1 began with a CLICK that Milo heard first.', ...over }
}

describe('applyRevisions (VT-FR3)', () => {
  it('applies an edit to the one sentence it names and leaves the rest byte-identical', () => {
    const out = applyRevisions(story, [edit({})])
    expect(out.applied).toBe(1)
    expect(out.story.chapters[0]!.text.startsWith('Chapter 1 began with a CLICK that Milo heard first.')).toBe(true)
    expect(out.story.chapters[0]!.text.slice('Chapter 1 began with a CLICK that Milo heard first.'.length)).toBe(story.chapters[0]!.text.slice(first.length))
    expect(out.story.chapters.slice(1)).toEqual(story.chapters.slice(1))
    expect(out.story.title).toBe(story.title)
    expect(out.story.chapters.map((c) => c.heading)).toEqual(story.chapters.map((c) => c.heading))
  })

  it('drops an edit whose find is missing, or appears more than once', () => {
    const repeated = story.chapters[0]!.text.split(' ').slice(10, 12).join(' ')
    expect(story.chapters[0]!.text.split(repeated).length).toBeGreaterThan(2)
    const out = applyRevisions(story, [edit({ find: 'not in the chapter at all' }), edit({ find: repeated })])
    expect(out.applied).toBe(0)
    expect(out.rejected).toBe(2)
    expect(out.story).toEqual(story)
  })

  it('cannot reach the title, subtitle or headings', () => {
    const out = applyRevisions(story, [
      { part: 'title' as ReviseEdit['part'], index: 0, find: story.title, replace: 'A New Title' },
      edit({ index: 99 }),
    ])
    expect(out.applied).toBe(0)
    expect(out.story.title).toBe(story.title)
  })

  it('caps the total text replaced, so a revision is never a rewrite in disguise', () => {
    const whole = story.chapters.map((c, i) => edit({ index: i, find: c.text, replace: `${c.text} More.` }))
    const out = applyRevisions(story, whole)
    expect(out.applied).toBeGreaterThan(0)
    expect(out.applied).toBeLessThan(whole.length)
    expect(out.rejected).toBe(whole.length - out.applied)
  })

  it('applies at most REVISE_MAX_EDITS edits', () => {
    const many = Array.from({ length: REVISE_MAX_EDITS + 4 }, () => edit({ find: 'Chapter 1 began', replace: 'Chapter 1 began' }))
    expect(applyRevisions(story, many).applied + applyRevisions(story, many).rejected).toBe(REVISE_MAX_EDITS)
  })

  it('edits and removes True Facts, but never below the minimum of 8', () => {
    const facts = story.true_facts.map((f, i): ReviseEdit => ({ part: 'true_fact', index: i, find: f.text, replace: '' }))
    const out = applyRevisions(story, facts)
    expect(out.story.true_facts).toHaveLength(8)
    expect(out.applied).toBe(1)

    const fixed = applyRevisions(story, [{ part: 'true_fact', index: 2, find: 'number 3', replace: 'number three' }])
    expect(fixed.story.true_facts[2]!.text).toBe('True fact number three about LEGO.')
    expect(fixed.story.true_facts[2]!.fact_id).toBe('f3')
  })

  it('reads the entity-escaped quotes the model saw, and never writes an entity into the story', () => {
    const amp = { ...story, chapters: story.chapters.map((c, i) => (i === 0 ? { ...c, text: `Lewis & Clark <went> west. ${c.text}` } : c)) }
    const out = applyRevisions(amp, [{ part: 'chapter', index: 0, find: 'Lewis &amp; Clark &lt;went&gt; west.', replace: 'Lewis &amp; Clark paddled west.' }])
    expect(out.applied).toBe(1)
    expect(out.story.chapters[0]!.text.startsWith('Lewis & Clark paddled west. ')).toBe(true)
  })

  it('keeps the whitespace the find spans: a trailing space or paragraph break is not trimmed away', () => {
    const out = applyRevisions(story, [edit({ find: `${first} `, replace: 'Milo heard it first. ' })])
    expect(out.applied).toBe(1)
    expect(out.story.chapters[0]!.text).toBe(`Milo heard it first. ${story.chapters[0]!.text.slice(first.length + 1)}`)
  })

  it('charges a removed True Fact its whole length against the cap, however little find quotes', () => {
    const facts = story.true_facts.map((f, i): ReviseEdit => ({ part: 'true_fact', index: i, find: f.text.slice(0, 1), replace: '' }))
    const out = applyRevisions(story, facts.slice(0, 1))
    expect(out.changedChars).toBe(story.true_facts[0]!.text.length)
  })

  it('fixes the ending line, and never empties it', () => {
    const ok = applyRevisions(story, [{ part: 'ending_line', index: 0, find: 'Play well.', replace: 'Play well, both of you.' }])
    expect(ok.story.ending_line).toBe('Goodnight, Milo. Goodnight, Juno. Play well, both of you.')
    const empty = applyRevisions(story, [{ part: 'ending_line', index: 0, find: story.ending_line, replace: '  ' }])
    expect(empty.applied).toBe(0)
    expect(empty.story.ending_line).toBe(story.ending_line)
  })
})

describe('problemsFor', () => {
  it('lists the gate reasons and each located safety quote, once', () => {
    const result = {
      rewrite_reasons: ['facts contradict the fact pack', 'GUARDRAILS rule 10 breached'],
      safety: { safe: false, violations: [{ rule: 10, quote: 'Juno patted the shark', severity: 'hard' }], scary_level: 0, positive_portrayal: true, ending_safe: true },
    } as unknown as QualityResult
    const problems = problemsFor(result)
    expect(problems).toHaveLength(3)
    expect(problems[2]).toContain('"Juno patted the shark"')
  })
})

describe('reviseInRounds', () => {
  const failing = { needsRewrite: true, result: { rewrite_reasons: ['x'] } as unknown as QualityResult }
  const passing = { needsRewrite: false, result: { rewrite_reasons: [] } as unknown as QualityResult }
  const reply = (edits: number, changedChars = 50): ReviseResult =>
    ({ story, edits, rejected: 0, changedChars, costUsd: 0.02, proposed: edits, stopReason: 'end_turn', text: '' })

  it('stops at the first round whose regate passes', async () => {
    let regates = 0
    const out = await reviseInRounds(story, failing, { revise: async () => reply(3), regate: async () => (++regates === 1 ? failing : passing) })
    expect(out).toMatchObject({ passed: true, rounds: 2, edits: 6 })
  })

  it('gives up after REVISE_MAX_ROUNDS, on a round with no edits, or when told to stop', async () => {
    expect(await reviseInRounds(story, failing, { revise: async () => reply(2), regate: async () => failing })).toMatchObject({ passed: false, rounds: REVISE_MAX_ROUNDS })
    expect(await reviseInRounds(story, failing, { revise: async () => reply(0), regate: async () => passing })).toMatchObject({ passed: false, rounds: 1, edits: 0 })
    expect(await reviseInRounds(story, failing, { revise: async () => reply(2), regate: async () => passing, canStart: () => false })).toMatchObject({ passed: false, rounds: 0 })
  })

  it('stops before the rounds together replace more than half the story', async () => {
    const big = story.chapters.reduce((n, c) => n + c.text.length, 0) * 0.3
    const out = await reviseInRounds(story, failing, { revise: async () => reply(5, big), regate: async () => failing })
    expect(out).toMatchObject({ passed: false, rounds: 2, edits: 5 })
  })
})
