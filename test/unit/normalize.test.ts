import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeStoryCandidate, salvageTrueFacts } from '@/lib/generate/normalize'
import { parseStoryOutputLocal } from '@/lib/generate/parse'
import { factTermsMissingFromStory } from '@/lib/quality/facts-in-story'
import { runDeterministicChecks } from '@/lib/quality/deterministic'
import { StoryOutput, type StoryOutput as Story } from '@/lib/schemas'
import { goodFactPack, goodStoryRaw } from '../helpers/story'

/**
 * Metadata slips are fixed locally and for free; story prose is never touched.
 *
 * Every one of the owner's first stories failed schema validation and paid for a Haiku
 * repair; one repair failed and a finished story was thrown away.
 */

const firstRealStory = JSON.parse(
  readFileSync(join(process.cwd(), 'test/fixtures/stories/first-real-story-volcanoes.json'), 'utf8'),
) as Story

type Loose = Record<string, unknown> & {
  chapters: { text: string; shout_line: string | null }[]
  true_facts: { text: string; fact_id: string }[]
  bible_suggestions: Record<string, unknown> | null
}
function raw(): Loose {
  return structuredClone(goodStoryRaw()) as Loose
}

describe('normalizeStoryCandidate', () => {
  it('changes nothing in a story that is already valid', () => {
    const { value, notes } = normalizeStoryCandidate(raw())
    expect(notes).toEqual([])
    expect(value).toEqual(raw())
  })

  it('fixes the slips that used to cost a repair call, and says what it did', () => {
    const story = raw()
    story.chapters[0]!.shout_line = 'X'.repeat(81)
    story.subtitle = 'S'.repeat(201)
    story.bible_suggestions!.new_recurring = [
      { name: 'Rocky', type: 'device', rule: 'glows '.repeat(60) },
      { name: 'A guide', type: 'mentor', rule: 'not a type we have' },
      { name: 'Two', type: 'place', rule: 'r' },
      { name: 'Three', type: 'object', rule: 'r' },
    ]
    story.estimated_read_minutes = 0
    story.true_facts.push({ text: 'No id here.', fact_id: 'fact-seven' })

    expect(StoryOutput.safeParse(story).success).toBe(false)
    const { value, notes } = normalizeStoryCandidate(story)
    const parsed = StoryOutput.safeParse(value)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)

    const fixed = parsed.data!
    expect(fixed.chapters[0]!.shout_line).toBeNull()
    expect(fixed.subtitle).toBeNull()
    expect(fixed.bible_suggestions.new_recurring.map((r) => r.name)).toEqual(['Rocky', 'Two'])
    expect(fixed.bible_suggestions.new_recurring[0]!.rule.length).toBeLessThanOrEqual(240)
    expect(fixed.estimated_read_minutes).toBeGreaterThan(0)
    expect(fixed.true_facts).toHaveLength(9)
    expect(notes.length).toBeGreaterThanOrEqual(5)
  })

  it('never changes a word of the story', () => {
    const story = raw()
    story.chapters[0]!.shout_line = 'X'.repeat(200)
    story.bible_suggestions = null
    const before = story.chapters.map((c) => c.text)
    const { value } = normalizeStoryCandidate(story)
    const after = (value as Loose).chapters.map((c) => c.text)
    expect(after).toEqual(before)
    expect((value as Loose).ending_line).toBe(story.ending_line)
  })

  it('leaves prose problems for the gate: too few chapters is not a metadata slip', () => {
    const story = raw()
    story.chapters = story.chapters.slice(0, 3)
    expect(StoryOutput.safeParse(normalizeStoryCandidate(story).value).success).toBe(false)
  })

  it('is part of the local parse, so a fixable story never reaches the repair call', () => {
    const story = raw()
    story.chapters[2]!.shout_line = 'Y'.repeat(120)
    const outcome = parseStoryOutputLocal(JSON.stringify(story))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.notes).toEqual(['chapter 3: shout_line over 80 characters: removed'])
  })

  it('passes non-objects through for the parser to reject', () => {
    expect(normalizeStoryCandidate('nope')).toEqual({ value: 'nope', notes: [] })
    expect(normalizeStoryCandidate(null)).toEqual({ value: null, notes: [] })
  })
})

describe('the True Facts list names only what the story said', () => {
  it('finds the adult term the first real story copied from the fact pack', () => {
    // The story told this fact as "two of Earth's giant plates are slowly pulling apart".
    // The list named the "Mid-Atlantic Ridge", which no child had heard in the story.
    expect(factTermsMissingFromStory(firstRealStory)).toEqual([
      { index: 10, fact_id: 'f20', term: 'Mid-Atlantic Ridge' },
    ])
  })

  it('allows paraphrase: "pull-along duck" for a duck that was pulled along', () => {
    const story = StoryOutput.parse(raw())
    story.true_facts[0]!.text = 'The first toy was a **pull-along duck**, made in **1932**.'
    expect(factTermsMissingFromStory(story)).toEqual([])
  })

  it('does not find a compound through its prefix', () => {
    const story = StoryOutput.parse(raw())
    story.chapters[0]!.text += ' It was super hot.'
    story.true_facts[0]!.text = 'Yellowstone sits on a **supervolcano**.'
    expect(factTermsMissingFromStory(story).map((m) => m.term)).toEqual(['supervolcano'])
  })

  it('removes the items that cannot stand, and the gate then passes the list', () => {
    const { value, notes } = salvageTrueFacts(firstRealStory, null)
    expect(firstRealStory.true_facts).toHaveLength(14)
    expect(value.true_facts).toHaveLength(13)
    expect(value.true_facts.map((f) => f.fact_id)).not.toContain('f20')
    expect(notes).toEqual([
      'true_facts: removed an item - f20 names "Mid-Atlantic Ridge", which the story never used',
    ])
    expect(factTermsMissingFromStory(value)).toEqual([])
    expect(value.chapters).toEqual(firstRealStory.chapters)
  })

  it('removes an item whose fact_id is not in the pack', () => {
    const story = StoryOutput.parse(raw())
    story.true_facts.push({ text: 'An extra fact.', fact_id: 'f99' })
    const { value, notes } = salvageTrueFacts(story, goodFactPack())
    expect(value.true_facts.map((f) => f.fact_id)).not.toContain('f99')
    expect(notes).toEqual(['true_facts: removed an item - f99 is not in the fact pack'])
  })

  it('is all or nothing: below the minimum it removes none, and the gate names the reason', () => {
    const story = StoryOutput.parse(raw())
    story.true_facts = story.true_facts.slice(0, 8)
    story.true_facts[0]!.text = 'Made of **acrylonitrile butadiene styrene**.'
    const { value, notes } = salvageTrueFacts(story, goodFactPack())
    expect(notes).toEqual([])
    expect(value.true_facts).toHaveLength(8)

    const gate = runDeterministicChecks({
      story: value,
      children: [
        { name: 'Cruz', age: 7 },
        { name: 'Phoenix', age: 4 },
      ],
      band: 'A',
      minutes: 10,
      targetWords: { min: 1300, max: 1700 },
      factPack: goodFactPack(),
    })
    expect(gate.failures.map((f) => f.check)).toEqual(['true_fact_not_in_story'])
    expect(gate.failures[0]!.detail).toContain('acrylonitrile butadiene styrene')
  })
})

describe('sentence length is a deterministic check', () => {
  it('fails the first real story with a reason the writer can act on', () => {
    const gate = runDeterministicChecks({
      story: salvageTrueFacts(firstRealStory, null).value,
      children: [
        { name: 'Cruz', age: 4 },
        { name: 'Phoenix', age: 7 },
      ],
      band: 'A',
      minutes: 10,
      targetWords: { min: 1300, max: 1700 },
      factPack: null,
    })
    expect(gate.failures.map((f) => f.check)).toEqual(['sentence_length'])
    expect(gate.failures[0]!.detail).toMatch(/over 20 words \(limit 8%\)\. Split the long sentences\./)
    expect(gate.sentences?.sentences).toBeGreaterThan(100)
  })
})
