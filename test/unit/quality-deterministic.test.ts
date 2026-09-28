import { describe, expect, it } from 'vitest'
import { runDeterministicChecks } from '@/lib/quality/deterministic'
import { targetWords, type AgeBand, type DeterministicCheck, type LengthMinutes } from '@/lib/schemas'
import { goodFactPack, goodStory, goodStoryRaw } from '../helpers/story'

/**
 * F7 VT: "each deterministic check has a passing and failing fixture".
 *
 * Every case starts from `goodStory()`, which passes everything, and breaks exactly one
 * thing - so a failure names one reason code and the test cannot pass for the wrong reason.
 * Assertions are on the stable codes and details, never on prose (CLAUDE.md conventions).
 */

interface Case {
  band?: AgeBand
  minutes?: LengthMinutes
  children?: { name: string; age: number }[]
  factPack?: ReturnType<typeof goodFactPack> | null
}

function check(story: unknown, opts: Case = {}) {
  const band = opts.band ?? 'A'
  const minutes = opts.minutes ?? 10
  return runDeterministicChecks({
    story,
    children: opts.children ?? [
      { name: 'Cruz', age: 7 },
      { name: 'Phoenix', age: 4 },
    ],
    band,
    minutes,
    targetWords: targetWords({ band, minutes }),
    factPack: opts.factPack === undefined ? goodFactPack() : opts.factPack,
  })
}

function codes(result: ReturnType<typeof check>): DeterministicCheck[] {
  return result.failures.map((f) => f.check)
}
function details(result: ReturnType<typeof check>): string[] {
  return result.failures.map((f) => f.detail)
}

describe('the known-good story passes every deterministic check', () => {
  it('passes with no failures at all', () => {
    const result = check(goodStory())
    expect(details(result)).toEqual([])
    expect(result.passed).toBe(true)
    expect(result.skipped).toEqual([])
  })
})

describe('schema_valid', () => {
  it('fails, and skips every other check, when true_facts is missing', () => {
    const story = goodStory() as unknown as Record<string, unknown>
    delete story.true_facts
    const result = check(story)
    expect(codes(result)).toEqual(['schema_valid'])
    expect(details(result)[0]).toContain('true_facts')
    expect(result.skipped.join(' ')).toContain('did not parse')
  })

  it('fails on fewer than 6 chapters (§4.1.2 asks for 6-10)', () => {
    expect(codes(check(goodStoryRaw({ chapters: 5 })))).toEqual(['schema_valid'])
  })

  it('fails on more than 10 chapters', () => {
    expect(codes(check(goodStoryRaw({ chapters: 11 })))).toEqual(['schema_valid'])
  })
})

describe('word_count_in_range', () => {
  it('passes at the top of band A on the +15% tolerance, as the references do', () => {
    // 9 x 215 + ending = ~1,943, above the nominal 1,700 ceiling but inside tolerance.
    const result = check(goodStory({ wordsPerChapter: 215 }))
    expect(codes(result)).not.toContain('word_count_in_range')
  })

  it('fails when the story is too short for the band', () => {
    const result = check(goodStory({ wordsPerChapter: 80 }))
    expect(codes(result)).toContain('word_count_in_range')
    expect(details(result).join()).toMatch(/word_count_in_range:\d+ not in 1300-1700/)
  })

  it('fails when the story is too long for the band', () => {
    const result = check(goodStory({ wordsPerChapter: 300 }))
    expect(codes(result)).toContain('word_count_in_range')
  })

  it('scales with the requested minutes', () => {
    const short = goodStory({ chapters: 6, wordsPerChapter: 130 })
    expect(codes(check(short, { minutes: 5 }))).not.toContain('word_count_in_range')
    expect(codes(check(short, { minutes: 15 }))).toContain('word_count_in_range')
  })
})

describe('child_missing and child_name_coverage', () => {
  it('fails with child_missing:Phoenix when Phoenix is never named', () => {
    const story = goodStory({ titleNames: 'Cruz' })
    story.subtitle = 'A bedtime adventure through the true story of LEGO'
    story.chapters = story.chapters.map((c) => ({
      ...c,
      text: c.text.replace(/Phoenix/g, 'Cruz'),
    }))
    story.ending_line = 'Goodnight, Cruz. Play well.'
    const result = check(story)
    expect(details(result)).toContain('child_missing:Phoenix')
    // A missing child is not also reported as low coverage: one problem, one code.
    expect(codes(result)).not.toContain('child_name_coverage')
  })

  it('fails coverage when a child appears in fewer than 60% of chapters', () => {
    const story = goodStory()
    story.chapters = story.chapters.map((c, i) => ({
      ...c,
      text: i < 5 ? c.text.replace(/Phoenix/g, 'Cruz') : c.text,
    }))
    const result = check(story)
    expect(details(result)).toContain('child_name_coverage:Phoenix:4/9')
  })

  it('passes at exactly 60% coverage', () => {
    const story = goodStory({ chapters: 10 })
    story.chapters = story.chapters.map((c, i) => ({
      ...c,
      text: i < 4 ? c.text.replace(/Phoenix/g, 'Cruz') : c.text,
    }))
    expect(codes(check(story))).not.toContain('child_name_coverage')
  })
})

describe('child_has_action', () => {
  it('fails when a child only watches and speaks', () => {
    // Phoenix appears in every chapter, but never with a verb after their name.
    const story = goodStory({
      body: [
        'Cruz pressed the red brick and it went CLICK.',
        '"Wow," said Phoenix.',
        'In **1932** a carpenter in **Billund, Denmark** began making wooden toys.',
        'Cruz built a tower and it held together perfectly.',
        'Phoenix, meanwhile, was nowhere near any of it.',
      ].join(' '),
    })
    const result = check(story)
    expect(details(result)).toContain('child_has_action:Phoenix')
    expect(details(result)).not.toContain('child_has_action:Cruz')
  })

  it('passes when the child does one decisive thing', () => {
    expect(codes(check(goodStory()))).not.toContain('child_has_action')
  })
})

describe('unknown_child_name', () => {
  it('fails when a sibling nobody asked for is introduced', () => {
    const story = goodStory()
    story.chapters[2]!.text += ' Cruz turned to his little sister Willow and grinned.'
    expect(details(check(story))).toContain('unknown_child_name:Willow')
  })

  it('does not flag a selected child described as a brother', () => {
    const story = goodStory()
    story.chapters[2]!.text += ' Cruz turned to his brother Phoenix and grinned.'
    expect(codes(check(story))).not.toContain('unknown_child_name')
  })
})

describe('true_facts_count', () => {
  it('passes with 9 facts', () => {
    expect(codes(check(goodStory()))).not.toContain('true_facts_count')
  })

  it('a story with 7 facts is rejected by the schema before the count check', () => {
    const story = goodStory()
    story.true_facts = story.true_facts.slice(0, 7)
    expect(codes(check(story))).toEqual(['schema_valid'])
  })
})

describe('unsourced_fact, fact_min_age, fact_not_kid_safe', () => {
  it('fails unsourced_fact when a fact_id is not in the pack', () => {
    const story = goodStory()
    story.true_facts[3] = { text: 'Something nobody researched.', fact_id: 'f99' }
    expect(details(check(story))).toContain('unsourced_fact:f99')
  })

  it('fails fact_min_age when a fact is too old for the youngest child', () => {
    const pack = goodFactPack()
    pack.facts[2]!.min_age = 8
    const result = check(goodStory(), { factPack: pack })
    expect(details(result)).toContain('fact_min_age:f3:8>4')
  })

  it('fails fact_not_kid_safe when the pack marked the fact unsafe', () => {
    const pack = goodFactPack({ sensitive_notes: 'Handle the 1942 fire gently.' })
    pack.facts[4]!.kid_safe = false
    const result = check(goodStory(), { factPack: pack })
    expect(details(result)).toContain('fact_not_kid_safe:f5')
  })

  it('skips all three checks, and says so, when there is no fact pack', () => {
    const result = check(goodStory(), { factPack: null })
    expect(codes(result)).not.toContain('unsourced_fact')
    expect(result.skipped.join(' ')).toContain('no fact pack supplied')
  })
})

describe('ending_line_present', () => {
  it('an empty ending line is caught by the schema; whitespace-only by the check', () => {
    const story = goodStory() as unknown as Record<string, unknown>
    story.ending_line = '   '
    // zod .trim().min(1) rejects whitespace-only, so this surfaces as a schema failure.
    expect(codes(check(story))).toEqual(['schema_valid'])
  })

  it('passes with a real ending line', () => {
    expect(codes(check(goodStory()))).not.toContain('ending_line_present')
  })
})

describe('banned_word', () => {
  it('fails on an unambiguous term', () => {
    const story = goodStory()
    story.chapters[1]!.text += ' He picked up the gun and put it down again.'
    expect(details(check(story))).toContain('banned_word:gun')
  })

  it('fails on a phrase', () => {
    const story = goodStory()
    story.chapters[1]!.text += ' There was a dead body in the workshop.'
    expect(details(check(story))).toContain('banned_word:dead body')
  })

  it('does not fail on allowlisted prose', () => {
    const story = goodStory()
    story.chapters[1]!.text += ' A killer whale swam past. It was a dead end.'
    expect(codes(check(story))).not.toContain('banned_word')
  })

  it('scans an injected extra blocklist too, so lane 6 can add theirs', () => {
    const story = goodStory()
    story.chapters[1]!.text += ' The word flibbertigibbet appeared in the workshop.'
    const band: AgeBand = 'A'
    const result = runDeterministicChecks({
      story,
      children: [{ name: 'Cruz', age: 7 }, { name: 'Phoenix', age: 4 }],
      band,
      minutes: 10,
      targetWords: targetWords({ band, minutes: 10 }),
      factPack: goodFactPack(),
      extraBlocklists: [{ terms: ['flibbertigibbet'], phrases: [], allow: [] }],
    })
    expect(result.failures.map((f) => f.detail)).toContain('banned_word:flibbertigibbet')
  })
})

describe('chapter_word_share', () => {
  it('fails when one chapter takes more than 40% of the words', () => {
    const story = goodStory({ chapters: 6, wordsPerChapter: 100 })
    story.chapters[0]!.text = story.chapters[0]!.text.repeat(8)
    const result = check(story)
    expect(codes(result)).toContain('chapter_word_share')
    expect(details(result).join()).toMatch(/chapter_word_share:0:0\.\d+/)
  })

  it('passes when the chapters are evenly weighted', () => {
    expect(codes(check(goodStory()))).not.toContain('chapter_word_share')
  })
})

describe('cliffhanger_marker', () => {
  it('fails on dread held over a chapter break', () => {
    const story = goodStory()
    story.chapters[3]!.text += ' And it was right behind him...'
    const result = check(story)
    expect(details(result)).toContain('cliffhanger_marker:3')
  })

  it('fails on an interrobang ending', () => {
    const story = goodStory()
    story.chapters[2]!.text += ' What was that noise?!'
    expect(details(check(story))).toContain('cliffhanger_marker:2')
  })

  it('allows an ellipsis after a capitalised sound word, as the shark reference does', () => {
    const story = goodStory()
    story.chapters[4]!.text += ' The whole ocean went **WHOOOOSH**...'
    expect(codes(check(story))).not.toContain('cliffhanger_marker')
  })
})

describe('contains_url_or_contact', () => {
  it('fails on a URL', () => {
    const story = goodStory()
    story.chapters[1]!.text += ' You can read more at https://lego.com/history today.'
    expect(details(check(story))).toContain('contains_url_or_contact:url')
  })

  it('fails on an email address', () => {
    const story = goodStory()
    story.chapters[1]!.text += ' Write to ole@billund.example for more.'
    expect(codes(check(story))).toContain('contains_url_or_contact')
  })

  it('does not fail on the dates and scores a real story contains', () => {
    const story = goodStory()
    story.chapters[1]!.text +=
      ' On January 28, 1958 the patent was granted. Uruguay beat Argentina 4-2 in 1930, and 50,000 fans watched.'
    expect(codes(check(story))).not.toContain('contains_url_or_contact')
  })
})

describe('meta_content', () => {
  it('fails when the story talks about its own machinery', () => {
    const story = goodStory()
    story.chapters[0]!.text += ' As an AI, I should mention the system prompt here.'
    const result = check(story)
    expect(codes(result)).toContain('meta_content')
    expect(details(result)).toContain('meta_content:as an ai')
  })

  it('does not flag a real person who happens to be called Claude', () => {
    const story = goodStory()
    story.chapters[0]!.text += ' Claude Monet painted the water lilies in his own garden.'
    expect(codes(check(story))).not.toContain('meta_content')
  })
})
