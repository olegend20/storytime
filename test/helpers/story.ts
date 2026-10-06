import {
  FactPack,
  StoryOutput,
  targetWords,
  type AgeBand,
  type FactPack as FactPackType,
  type GenerationRequest,
  type LengthMinutes,
  type StoryOutput as StoryOutputType,
} from '@/lib/schemas'

/**
 * Builders for gate and pipeline tests: a story that PASSES every deterministic check, so
 * each test can break exactly one thing and assert exactly one reason code. A shared
 * "known good" is the only way those tests stay readable.
 */

/** Short sentences, as the band rubric asks: the gate measures sentence length. */
const CHAPTER_BODY = [
  'Milo pressed the red brick. It went CLICK.',
  '"Look at this," said Juno. He held up a tiny wooden duck on wheels.',
  'The year was **1932**. A carpenter called **Ole Kirk Christiansen** made wooden toys.',
  'His workshop was in **Billund, Denmark**. Families still needed something to play with.',
  'Juno pulled the duck across the floor. It went quack-clack, quack-clack.',
  'Milo built a tower out of the new bricks. It held together perfectly.',
].join(' ')

export interface GoodStoryOptions {
  chapters?: number
  wordsPerChapter?: number
  /** Prose repeated to fill each chapter. Defaults to CHAPTER_BODY. */
  body?: string
  /** Included in the title. Set to a single name to make another child genuinely absent. */
  titleNames?: string
}

/** 9 chapters x 170 words + the ending line = ~1,540 words: inside band A at 10 minutes. */
export function goodStory(opts: GoodStoryOptions = {}): StoryOutputType {
  return StoryOutput.parse(goodStoryRaw(opts))
}

/**
 * The same builder without validation, so a test can assert on `schema_valid` itself.
 * `StoryOutput.parse` would otherwise throw inside the fixture rather than inside the gate.
 */
export function goodStoryRaw(opts: GoodStoryOptions = {}): Record<string, unknown> {
  const chapters = opts.chapters ?? 9
  const words = opts.wordsPerChapter ?? 170
  const fill = (opts.body ?? CHAPTER_BODY).split(/\s+/)
  const chapterTextFor = (index: number): string => {
    const out = `Chapter ${index + 1} began with a sound nobody expected.`.split(/\s+/)
    let i = 0
    while (out.length < words) {
      out.push(fill[i % fill.length]!)
      i += 1
    }
    return out.slice(0, words).join(' ')
  }
  return {
    title: `${opts.titleNames ?? 'Milo, Juno'} and the Brick That Clicked`,
    subtitle: 'A bedtime adventure through the true story of LEGO',
    chapters: Array.from({ length: chapters }, (_, i) => ({
      heading: `Chapter ${i + 1}: The Workshop in Billund`,
      text: chapterTextFor(i),
      shout_line: i === 0 ? 'PLAY WELL!' : null,
    })),
    ending_line: 'Goodnight, Milo. Goodnight, Juno. Play well.',
    true_facts: Array.from({ length: 9 }, (_, i) => ({
      text: `True fact number ${i + 1} about LEGO.`,
      fact_id: `f${i + 1}`,
    })),
    bible_suggestions: {
      new_recurring: [
        {
          name: 'The magic red LEGO brick',
          type: 'device',
          rule: 'glows and clicks to start an adventure; returns them home at the end',
        },
      ],
      ending_summary: 'The last brick on their tower finally went CLICK and held.',
    },
    estimated_read_minutes: 10,
  }
}

/** A pack whose ids match `goodStory`'s true_facts, so the mapping checks pass. */
export function goodFactPack(overrides: Partial<FactPackType> = {}): FactPackType {
  return FactPack.parse({
    topic_key: 'history-of-lego',
    topic_label: 'The history of LEGO',
    summary: 'LEGO began in Billund, Denmark, as a small wooden-toy workshop.',
    facts: Array.from({ length: 14 }, (_, i) => ({
      id: `f${i + 1}`,
      text: `A concrete, checkable fact number ${i + 1} about the history of LEGO.`,
      kid_safe: true,
      min_age: 3,
      confidence: 'high',
      source_ids: ['s1'],
    })),
    timeline: [{ year: 1932, event: 'Ole Kirk Christiansen starts making wooden toys' }],
    characters: [
      {
        name: 'Ole Kirk Christiansen',
        role: 'founder',
        kid_friendly_note: 'kind carpenter who never gave up',
      },
    ],
    sensitive_notes: null,
    sources: [{ id: 's1', title: 'LEGO history', url: 'https://example.com/lego' }],
    ...overrides,
  })
}

export interface RequestOptions {
  band?: AgeBand
  minutes?: LengthMinutes
  children?: { name: string; age: number; likes?: string[]; notes?: string | null }[]
  rewriteReasons?: string[]
  avoid?: string[]
  careNotes?: string | null
  requestedCharacters?: string[]
}

export function request(opts: RequestOptions = {}): GenerationRequest {
  const band = opts.band ?? 'A'
  const minutes = opts.minutes ?? 10
  const children = opts.children ?? [
    { name: 'Milo', age: 7, likes: ['LEGO', 'sharks'] },
    { name: 'Juno', age: 4, likes: ['dinosaurs'] },
  ]
  return {
    children: children.map((c) => ({
      name: c.name,
      age: c.age,
      likes: c.likes ?? [],
      notes: c.notes ?? null,
    })),
    age_band: band,
    tones: ['funny', 'exciting'],
    length_minutes: minutes,
    target_words: targetWords({ band, minutes }),
    topic_label: 'The history of LEGO',
    topic_key: 'history-of-lego',
    avoid: opts.avoid ?? [],
    care_notes: opts.careNotes ?? null,
    requested_characters: opts.requestedCharacters ?? [],
    rewrite_reasons: opts.rewriteReasons ?? [],
  }
}
