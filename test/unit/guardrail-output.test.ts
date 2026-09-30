import { describe, expect, it } from 'vitest'
import { MAX_SCARY_LEVEL } from '@/lib/schemas/common'
import type { StoryOutput } from '@/lib/schemas/story'
import { runOutputGate } from '@/lib/guardrails/gate'
import { checkTrueFacts, scanStoryStructure, scanStoryText } from '@/lib/guardrails/output'
import { HARD_RULE_TEXT } from '@/lib/guardrails/prompt'

/**
 * GUARDRAILS.md s4.2/s4.3 and the F15 output VTs:
 *  - a story violating rule 3 -> rewrite requested with the violation in the instructions
 *  - a second violation -> story discarded, parent message shown, quota unchanged
 *  - deterministic checks run first; a hard deterministic violation skips the model call
 */

function story(overrides: Partial<StoryOutput> = {}): StoryOutput {
  const chapter = (heading: string, text: string) => ({ heading, text, shout_line: null })
  return {
    title: 'Milo and Juno and the Deep Blue',
    subtitle: null,
    chapters: [
      chapter('Chapter 1', 'Milo and Juno climbed into the little yellow submarine.'),
      chapter('Chapter 2', 'Juno counted six fish and Milo drew a map of the reef.'),
      chapter('Chapter 3', 'They found a wreck covered in coral and soft green weeds.'),
      chapter('Chapter 4', 'Grandpa Greenie showed them how a shark tooth grows back.'),
      chapter('Chapter 5', 'Milo steered home while Juno waved at a turtle.'),
      chapter('Chapter 6', 'They surfaced by the harbour wall, right on time for tea.'),
    ],
    ending_line: 'Goodnight, Milo. Goodnight, Juno. Sleep well.',
    true_facts: Array.from({ length: 8 }, (_, i) => ({
      text: `Fact number ${i + 1} about sharks.`,
      fact_id: `f${i + 1}`,
    })),
    bible_suggestions: { new_recurring: [], ending_summary: 'They came home for tea.' },
    estimated_read_minutes: 10,
    ...overrides,
  }
}

const cleanReview = async () => ({
  review: {
    safe: true,
    violations: [],
    scary_level: 0,
    positive_portrayal: true,
    ending_safe: true,
  },
  costUsd: 0.001,
})

describe('s4.2 deterministic output scan', () => {
  it('returns the breached rule number and a quote', () => {
    const scan = scanStoryText('He was covered in blood and a dead body lay on the deck.')
    const hard = scan.hardViolations
    expect(hard.map((v) => v.rule)).toContain(2)
    expect(hard[0]?.quote).toContain('blood')
  })

  it('treats bare emotive words as soft, not hard', () => {
    const scan = scanStoryText('The monster truck roared and Milo screamed with laughter.')
    expect(scan.hardViolations).toEqual([])
    expect(scan.violations.some((v) => v.severity === 'soft')).toBe(true)
  })

  it('honours a per-topic allowance for an allow_with_care biology story', () => {
    const text = 'The nurse looked at his blood under the microscope.'
    expect(scanStoryText(text, { extraAllowed: ['his blood'] }).hardViolations).toEqual([])
  })

  it('flags URLs, emails and phone numbers in the prose', () => {
    const scan = scanStoryText('Write to milo@example.com or see www.example.com for more.')
    expect(scan.failures.map((f) => f.check)).toContain('contains_url_or_contact')
  })

  it('notices a missing child and an invented sibling', () => {
    const scan = scanStoryStructure(story(), {
      childNames: ['Milo', 'Juno', 'Theo'],
      knownOtherNames: ['Grandpa Greenie'],
    })
    expect(scan.failures.map((f) => f.detail)).toContain('child_missing:Theo')
    expect(scan.failures.map((f) => f.detail)).toContain('unknown_child_name:Grandpa Greenie')
  })

  it('raises a cliffhanger check for a prose ellipsis but not for a sound effect', () => {
    const dread = story({
      chapters: story().chapters.map((c, i) =>
        i === 2 ? { ...c, text: 'And then the door creaked open behind him...' } : c,
      ),
    })
    expect(
      scanStoryStructure(dread, { childNames: ['Milo', 'Juno'] }).failures.map((f) => f.check),
    ).toContain('cliffhanger_marker')

    const whoosh = story({
      chapters: story().chapters.map((c, i) =>
        i === 2 ? { ...c, text: 'The whole ocean went **WHOOOOSH**...' } : c,
      ),
    })
    expect(
      scanStoryStructure(whoosh, { childNames: ['Milo', 'Juno'] }).failures.map((f) => f.check),
    ).not.toContain('cliffhanger_marker')
  })
})

describe('s4.4 the True Facts list', () => {
  const facts = Array.from({ length: 8 }, (_, i) => ({
    id: `f${i + 1}`,
    kid_safe: true,
    min_age: 4,
  }))

  it('passes when every item maps to a kid-safe fact within the age limit', () => {
    expect(checkTrueFacts(story(), facts, 4)).toEqual([])
  })

  it('fails an item whose fact_id is not in the pack', () => {
    const withGhost = story({
      true_facts: [...story().true_facts.slice(1), { text: 'Invented.', fact_id: 'f99' }],
    })
    expect(checkTrueFacts(withGhost, facts, 4).map((f) => f.check)).toContain('unsourced_fact')
  })

  it('fails an item referencing a kid_safe:false fact', () => {
    const unsafe = facts.map((f, i) => (i === 2 ? { ...f, kid_safe: false } : f))
    const failures = checkTrueFacts(story(), unsafe, 4)
    expect(failures.map((f) => f.check)).toContain('fact_not_kid_safe')
    expect(failures[0]?.detail).toBe('fact_not_kid_safe:f3')
  })

  it('fails an item whose fact min_age is above the youngest child', () => {
    const older = facts.map((f, i) => (i === 0 ? { ...f, min_age: 9 } : f))
    expect(checkTrueFacts(story(), older, 4).map((f) => f.detail)).toContain('fact_min_age:f1:9>4')
    expect(checkTrueFacts(story(), older, 9)).toEqual([])
  })
})

describe('s4.1 output gate outcomes', () => {
  it('passes a clean story', async () => {
    const result = await runOutputGate({
      story: story(),
      band: 'A',
      childNames: ['Milo', 'Juno'],
      attempt: 1,
      review: cleanReview,
    })
    expect(result.outcome).toBe('pass')
    expect(result.passed).toBe(true)
    expect(result.parentMessage).toBeNull()
  })

  it('requests a rewrite on a first rule 3 breach, with the violation in the reasons', async () => {
    const scary = story({
      chapters: story().chapters.map((c, i) =>
        i === 1
          ? { ...c, text: 'A monster was chasing them and it was right behind him in the dark.' }
          : c,
      ),
    })
    const result = await runOutputGate({
      story: scary,
      band: 'A',
      childNames: ['Milo', 'Juno'],
      attempt: 1,
      review: cleanReview,
    })
    expect(result.outcome).toBe('rewrite')
    expect(result.hardViolations.map((v) => v.rule)).toContain(3)
    expect(result.rewriteReasons.join(' ')).toContain('Rule 3')
    expect(result.rewriteReasons.join(' ')).toContain(HARD_RULE_TEXT[3]?.slice(0, 30) as string)
  })

  it('discards on a second breach and shows the parent the s5 output message', async () => {
    const scary = story({
      chapters: story().chapters.map((c, i) =>
        i === 1 ? { ...c, text: 'The monster chased them and no one heard him scream.' } : c,
      ),
    })
    const result = await runOutputGate({
      story: scary,
      band: 'A',
      childNames: ['Milo', 'Juno'],
      attempt: 2,
      review: cleanReview,
    })
    expect(result.outcome).toBe('discard')
    expect(result.parentMessage).toContain("didn't use one of your stories")
    expect(result.rewriteReasons).toEqual([])
  })

  it('skips the model review when a deterministic check already failed (s1.2)', async () => {
    let called = false
    const result = await runOutputGate({
      story: story({
        chapters: story().chapters.map((c, i) =>
          i === 0 ? { ...c, text: 'There was a dead body on the deck, covered in blood.' } : c,
        ),
      }),
      band: 'A',
      childNames: ['Milo', 'Juno'],
      attempt: 1,
      review: async () => {
        called = true
        return (await cleanReview()) as never
      },
    })
    expect(called).toBe(false)
    expect(result.skippedReview).toBe(true)
    expect(result.costUsd).toBe(0)
  })

  it('fails a story whose scary_level exceeds the band limit (s4.3)', async () => {
    for (const band of ['A', 'B', 'C', 'D'] as const) {
      const over = MAX_SCARY_LEVEL[band] + 1
      const result = await runOutputGate({
        story: story(),
        band,
        childNames: ['Milo', 'Juno'],
        attempt: 1,
        review: async () => ({
          review: {
            safe: true,
            violations: [],
            scary_level: over,
            positive_portrayal: true,
            ending_safe: true,
          },
          costUsd: 0,
        }),
      })
      if (over > 3) {
        expect(result.outcome, band).toBe('pass')
      } else {
        expect(result.outcome, band).toBe('rewrite')
        expect(result.hardViolations.map((v) => v.rule), band).toContain(3)
      }
    }
  })

  it('fails on positive_portrayal false (rule 13) and ending_safe false (rule 14)', async () => {
    const result = await runOutputGate({
      story: story(),
      band: 'C',
      childNames: ['Milo', 'Juno'],
      attempt: 1,
      review: async () => ({
        review: {
          safe: false,
          violations: [],
          scary_level: 1,
          positive_portrayal: false,
          ending_safe: false,
        },
        costUsd: 0,
      }),
    })
    const rules = result.hardViolations.map((v) => v.rule)
    expect(rules).toContain(13)
    expect(rules).toContain(14)
  })
})
