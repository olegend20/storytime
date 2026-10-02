import { describe, expect, it } from 'vitest'
import {
  BIBLE_MAX_RECURRING,
  BIBLE_MAX_TOPICS_COVERED,
  BIBLE_TOKEN_LIMIT,
  StoryBible,
  type RecurringElement,
  type StoryOutput,
} from '@/lib/schemas'
import {
  childKey,
  sortedChildIds,
  enforceBibleLimits,
  estimateBibleTokens,
  bibleFitsLimit,
  emptyBible,
  refreshBibleChildren,
  mergeBible,
  deterministicBibleUpdate,
  withoutCharacters,
  NEUTRAL_ENDING,
  buildBibleUpdateMessage,
  type ChildProfile,
} from '@/lib/bible'

/** F4 - series keying, size enforcement and the deterministic bible arithmetic. */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function child(name: string, age: number): ChildProfile {
  return {
    id: name.toLowerCase(),
    first_name: name,
    age,
    likes: ['LEGO'],
    notes: null,
    reading_level: null,
  }
}

function recurring(name: string, lastUsed: string): RecurringElement {
  return {
    name,
    type: 'character',
    rule: `${name} shows up and helps, slowly and kindly, with a joke about being old`,
    last_used: lastUsed,
  }
}

describe('F4 VT: childKey is order-independent', () => {
  it('childKey([b, a]) === childKey([a, b])', () => {
    expect(childKey([B, A])).toBe(childKey([A, B]))
  })

  it('a different SET of children is a different series', () => {
    expect(childKey([A, B])).not.toBe(childKey([A, B, C]))
    expect(childKey([A])).not.toBe(childKey([B]))
  })

  it('duplicates and casing do not create a second series', () => {
    expect(childKey([A, A, B])).toBe(childKey([B, A]))
    expect(childKey([A.toUpperCase(), B])).toBe(childKey([A, B]))
  })

  it('sortedChildIds is the canonical stored array', () => {
    expect(sortedChildIds([C, A, B, A])).toEqual([A, B, C])
  })

  it('refuses an empty set rather than keying every family the same', () => {
    expect(() => childKey([])).toThrow(/no child ids/)
  })
})

describe('F4 VT: enforceBibleLimits', () => {
  const base = StoryBible.parse({
    children: [
      { name: 'Milo', age: 7, likes: ['LEGO', 'sharks'], role_notes: 'has the ideas' },
      { name: 'Juno', age: 4, likes: ['dinosaurs'], role_notes: 'shouts the sound words' },
    ],
    recurring: [],
    catchphrases: ['Play well', 'WHOOOOSH'],
    topics_covered: [],
    last_story: { title: 'The Brick That Clicked', ending: 'The last brick went CLICK.' },
    tone_history: ['funny', 'exciting'],
    avoid: [],
  })

  it('trims topics_covered to the most recent 20', () => {
    const topics = Array.from({ length: 31 }, (_, i) => ({
      topic: `topic number ${i}`,
      story_id: null,
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    }))
    const result = enforceBibleLimits({ ...base, topics_covered: topics })
    expect(result.topics_covered.length).toBeLessThanOrEqual(BIBLE_MAX_TOPICS_COVERED)
    // The most recent survive: entry 30 is kept, entry 0 is not.
    expect(result.topics_covered.at(-1)?.topic).toBe('topic number 30')
    expect(result.topics_covered.map((t) => t.topic)).not.toContain('topic number 0')
  })

  it('trims recurring to 8, dropping least-recently-used first', () => {
    const items = [
      recurring('Oldest guide', '2026-01-01'),
      recurring('Second oldest', '2026-01-02'),
      recurring('Guide C', '2026-02-01'),
      recurring('Guide D', '2026-02-02'),
      recurring('Guide E', '2026-02-03'),
      recurring('Guide F', '2026-02-04'),
      recurring('Guide G', '2026-02-05'),
      recurring('Guide H', '2026-02-06'),
      recurring('Guide I', '2026-02-07'),
      recurring('Newest guide', '2026-03-01'),
    ]
    const result = enforceBibleLimits({ ...base, recurring: items })
    const names = result.recurring.map((r) => r.name)
    expect(result.recurring.length).toBeLessThanOrEqual(BIBLE_MAX_RECURRING)
    expect(names).toContain('Newest guide')
    expect(names).not.toContain('Oldest guide')
    expect(names).not.toContain('Second oldest')
    // Surviving entries keep their original order, not LRU order.
    expect(names).toEqual([...names].sort((a, b) => items.findIndex((i) => i.name === a) - items.findIndex((i) => i.name === b)))
  })

  it('treats a missing last_used as the oldest', () => {
    const undated: RecurringElement = {
      name: 'Undated guide',
      type: 'device',
      rule: 'has no last_used and should be dropped first',
    }
    const items = [
      undated,
      ...Array.from({ length: 8 }, (_, i) => recurring(`Guide ${i}`, `2026-02-0${i + 1}`)),
    ]
    const names = enforceBibleLimits({ ...base, recurring: items }).recurring.map((r) => r.name)
    expect(names).not.toContain('Undated guide')
    expect(names).toHaveLength(8)
  })

  it('brings an oversized bible under the 800-token limit', () => {
    const bloated = {
      ...base,
      recurring: Array.from({ length: 12 }, (_, i) => ({
        name: `A recurring element with quite a long name number ${i}`,
        type: 'character' as const,
        rule:
          'An unnecessarily long rule that goes on and on describing behaviour in far more ' +
          'detail than a future story could ever need, repeated to inflate the token count.',
        last_used: `2026-02-${String(i + 1).padStart(2, '0')}`,
      })),
      topics_covered: Array.from({ length: 30 }, (_, i) => ({
        topic: `a fairly long topic label number ${i} about something educational`,
        story_id: null,
        date: '2026-02-01',
      })),
      catchphrases: Array.from({ length: 10 }, (_, i) => `catchphrase number ${i} here`),
      tone_history: Array.from({ length: 20 }, (_, i) => `tone-${i}`),
      avoid: Array.from({ length: 10 }, (_, i) => `avoid doing this particular thing again, number ${i}`),
      last_story: {
        title: 'A rather long story title that keeps going for a while indeed',
        ending:
          'A long ending summary that describes the final image in considerable detail, ' +
          'far more than one sentence, repeated so the bible starts out over budget.',
      },
    }

    expect(estimateBibleTokens(bloated)).toBeGreaterThan(BIBLE_TOKEN_LIMIT)
    const result = enforceBibleLimits(bloated)
    expect(estimateBibleTokens(result)).toBeLessThanOrEqual(BIBLE_TOKEN_LIMIT)
    expect(bibleFitsLimit(result)).toBe(true)
    // It must still be a valid bible, and it must still know who the children are.
    expect(StoryBible.safeParse(result).success).toBe(true)
    expect(result.children.map((c) => c.name)).toEqual(['Milo', 'Juno'])
    // And it must keep the single most important field for continuity.
    expect(result.last_story?.title).toContain('A rather long story title')
  })

  it('leaves a small bible untouched', () => {
    const result = enforceBibleLimits(base)
    expect(result).toEqual(base)
  })
})

describe('F4: a new series bible is built from child profiles only', () => {
  it('has the children and nothing else', () => {
    const bible = emptyBible([child('Milo', 7), child('Juno', 4)])
    expect(bible.children.map((c) => c.name)).toEqual(['Milo', 'Juno'])
    expect(bible.recurring).toEqual([])
    expect(bible.catchphrases).toEqual([])
    expect(bible.topics_covered).toEqual([])
    expect(bible.last_story).toBeNull()
    expect(StoryBible.safeParse(bible).success).toBe(true)
  })
})

describe('F4 AC: editing a child propagates to the bible on next load', () => {
  const bible = StoryBible.parse({
    children: [{ name: 'Milo', age: 7, likes: ['LEGO'], role_notes: 'has the ideas' }],
    recurring: [],
    catchphrases: [],
    topics_covered: [],
    last_story: null,
    tone_history: [],
    avoid: [],
  })

  it('picks up a new age and new likes, keeping role_notes', () => {
    const refreshed = refreshBibleChildren(bible, [
      { ...child('Milo', 8), likes: ['LEGO', 'sharks'] },
    ])
    expect(refreshed).not.toBeNull()
    expect(refreshed!.children[0]).toEqual({
      name: 'Milo',
      age: 8,
      likes: ['LEGO', 'sharks'],
      role_notes: 'has the ideas',
    })
  })

  it('returns null when nothing changed, so a read causes no write', () => {
    expect(refreshBibleChildren(bible, [child('Milo', 7)])).toBeNull()
  })

  it('adding a child to the set is a different series, but the shape still updates', () => {
    const refreshed = refreshBibleChildren(bible, [child('Milo', 7), child('Juno', 4)])
    expect(refreshed?.children.map((c) => c.name)).toEqual(['Milo', 'Juno'])
    expect(refreshed?.children[1]?.role_notes).toBeNull()
  })
})

describe('F4: conflict resolution merges rather than clobbers', () => {
  const day = '2026-09-27'
  const base = StoryBible.parse({
    children: [{ name: 'Milo', age: 7, likes: ['LEGO'], role_notes: null }],
    recurring: [recurring('The magic red LEGO brick', '2026-09-25')],
    catchphrases: ['Play well'],
    topics_covered: [{ topic: 'history of LEGO', story_id: null, date: '2026-09-25' }],
    last_story: { title: 'The Brick That Clicked', ending: 'The last brick went CLICK.' },
    tone_history: ['funny'],
    avoid: [],
  })

  it('keeps both writers content', () => {
    // Another request already added a shark story while we were thinking.
    const theirs: typeof base = {
      ...base,
      topics_covered: [
        ...base.topics_covered,
        { topic: 'sharks', story_id: null, date: '2026-09-26' },
      ],
      last_story: { title: 'The Shark Submarine', ending: 'A tooth on the carpet.' },
    }
    // Our proposal was built on the older base and adds a volcano story.
    const ours: typeof base = {
      ...base,
      recurring: [...base.recurring, recurring('Professor Ash', day)],
      topics_covered: [
        ...base.topics_covered,
        { topic: 'volcanoes', story_id: null, date: day },
      ],
      catchphrases: ['Play well', 'KABOOM'],
      last_story: { title: 'The Volcano Lift', ending: 'A warm pebble on the rug.' },
    }

    const merged = mergeBible(theirs, ours, day)
    const topics = merged.topics_covered.map((t) => t.topic)
    expect(topics).toContain('sharks')
    expect(topics).toContain('volcanoes')
    expect(merged.recurring.map((r) => r.name)).toContain('Professor Ash')
    expect(merged.recurring.map((r) => r.name)).toContain('The magic red LEGO brick')
    expect(merged.catchphrases).toContain('KABOOM')
    // The proposal wins on the single-valued field: it is the newer story.
    expect(merged.last_story?.title).toBe('The Volcano Lift')
    expect(bibleFitsLimit(merged)).toBe(true)
  })

  it('does not duplicate a topic both writers recorded', () => {
    const same = { topic: 'sharks', story_id: null, date: '2026-09-26' }
    const merged = mergeBible(
      { ...base, topics_covered: [...base.topics_covered, same] },
      { ...base, topics_covered: [...base.topics_covered, same] },
      day,
    )
    expect(merged.topics_covered.filter((t) => t.topic === 'sharks')).toHaveLength(1)
  })
})

describe('F4: the no-model fallback keeps continuity', () => {
  const story: StoryOutput = {
    title: 'Milo, Juno and the Shark Submarine',
    subtitle: 'The next adventure of the magic LEGO brick',
    chapters: Array.from({ length: 7 }, (_, i) => ({
      heading: `Chapter ${i + 1}`,
      text: 'Milo pressed the brick and it clicked.',
      shout_line: i === 0 ? 'WHOOOOSH!' : null,
    })),
    ending_line: 'Goodnight, Milo. Goodnight, Juno. Swim well.',
    true_facts: Array.from({ length: 8 }, (_, i) => ({ text: `Fact ${i}`, fact_id: `f${i + 1}` })),
    bible_suggestions: {
      new_recurring: [
        { name: 'Grandpa Greenie', type: 'character', rule: 'a 400-year-old Greenland shark guide' },
      ],
      ending_summary: 'A shark tooth appeared on the bedroom floor.',
    },
    estimated_read_minutes: 10,
  }

  it('records the topic, the ending and the suggested recurring element', () => {
    const base = emptyBible([child('Milo', 7), child('Juno', 4)])
    const next = deterministicBibleUpdate(base, story, {
      topic: 'sharks',
      storyId: null,
      date: '2026-09-27',
      tones: ['funny', 'exciting'],
    })
    expect(next.recurring.map((r) => r.name)).toContain('Grandpa Greenie')
    expect(next.topics_covered.map((t) => t.topic)).toContain('sharks')
    expect(next.last_story?.ending).toContain('tooth')
    expect(next.catchphrases).toContain('WHOOOOSH!')
    expect(next.tone_history).toEqual(['funny', 'exciting'])
    expect(bibleFitsLimit(next)).toBe(true)
  })

  // Issue #27: a character borrowed for one night is not part of the series. The next story
  // has no rule-7 exception for it, so nothing in the bible may ask the writer to bring it back.
  it('keeps a borrowed character out of the series memory, wherever the proposal put it', () => {
    const base = emptyBible([child('Milo', 7), child('Juno', 4)])
    const elsa: StoryOutput = {
      ...story,
      chapters: story.chapters.map((c, i) => ({ ...c, shout_line: i === 0 ? 'ELSA, FREEZE IT!' : i === 1 ? 'SPLOOSH!' : null })),
      bible_suggestions: {
        new_recurring: [
          { name: 'Elsa', type: 'character', rule: 'arrives through a swirl of light' },
          { name: 'The glowing tooth brick', type: 'device', rule: 'hums when Elsa is near' },
          { name: 'Grandpa Greenie', type: 'character', rule: 'a 400-year-old Greenland shark guide' },
        ],
        ending_summary: 'They said goodnight to Elsa and the tooth brick glowed.',
      },
    }
    const proposal = deterministicBibleUpdate(
      { ...base, children: base.children.map((c) => ({ ...c, role_notes: 'held Elsa\'s hand' })) },
      elsa,
      { topic: 'sharks', storyId: null, date: '2026-10-02', tones: ['funny'] },
    )
    const next = withoutCharacters(proposal, ['Elsa'])
    expect(next.recurring.map((r) => r.name)).toEqual(['Grandpa Greenie'])
    expect(next.catchphrases).toEqual(['SPLOOSH!'])
    expect(next.last_story).toEqual({ title: elsa.title, ending: NEUTRAL_ENDING })
    expect(next.children.every((c) => c.role_notes === null)).toBe(true)
    expect(next.topics_covered.map((t) => t.topic)).toContain('sharks')
    // Nothing else is touched, and no names means no change at all.
    expect(withoutCharacters(proposal, [])).toBe(proposal)
    expect(JSON.stringify(next)).not.toMatch(/elsa/i)
  })
})

describe('F4: the bible-update prompt never carries a previous story', () => {
  it('sends only the old bible, the new story and metadata, all in data blocks', () => {
    const base = emptyBible([child('Milo', 7)])
    const message = buildBibleUpdateMessage(
      base,
      {
        title: 'T',
        subtitle: null,
        chapters: [],
        ending_line: 'x',
        true_facts: [],
        bible_suggestions: { new_recurring: [], ending_summary: 'y' },
        estimated_read_minutes: 10,
      } as unknown as StoryOutput,
      { topic: 'sharks', storyId: null, date: '2026-09-27', tones: ['funny'] },
    )
    expect(message).toContain('<old_bible>')
    expect(message).toContain('<story>')
    expect(message).toContain('<meta>')
    // Exactly three data blocks: no fourth block smuggling in story history.
    expect(message.match(/<\/[a-z_]+>/g)).toEqual(['</old_bible>', '</story>', '</meta>'])
  })
})
