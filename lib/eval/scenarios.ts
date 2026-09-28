import {
  bandForAges,
  targetWords,
  type AgeBand,
  type LengthMinutes,
  type StoryBible,
  type Tone,
} from '@/lib/schemas'

/**
 * The fixed eval scenarios.
 *
 * F13 names eight of them exactly; JUDGE_AGENT.md §6 adds four chosen for difficulty.
 * They are fixed on purpose: a golden set that drifts cannot be compared across runs,
 * so scenarios are only ever appended to, never edited. Editing one invalidates every
 * `eval/results/*.json` that came before it.
 */

export interface ScenarioChild {
  name: string
  age: number
  likes: string[]
  notes: string | null
}

export interface EvalScenario {
  id: string
  /** Why this scenario is in the set. Printed in the report so the set stays legible. */
  why: string
  suites: ('eval' | 'bakeoff')[]
  children: ScenarioChild[]
  topic_input: string
  topic_key: string
  tones: Tone[]
  length_minutes: LengthMinutes
  /** Series state BEFORE this story. Null for a first story. */
  bible: StoryBible | null
  checks: {
    /**
     * F13 AC: "continuity scenarios reference a prior recurring element in chapter 1."
     * Any one of these strings appearing in chapter 1 satisfies it.
     */
    continuity_reference?: string[]
    /** F13 AC: the-titanic must pass with scary_level <= 1 for band B. */
    max_scary_level?: number
  }
}

const CRUZ: ScenarioChild = { name: 'Cruz', age: 7, likes: ['LEGO', 'sharks'], notes: null }
const PHOENIX: ScenarioChild = { name: 'Phoenix', age: 4, likes: ['dinosaurs'], notes: null }
const LENNON: ScenarioChild = {
  name: 'Lennon',
  age: 10,
  likes: ['Roblox', 'building games in Roblox Studio', 'soccer'],
  notes: null,
}

/** The bible after the LEGO story - the state the sharks story was written against. */
const CRUZ_PHOENIX_BIBLE_AFTER_LEGO: StoryBible = {
  children: [
    { name: 'Cruz', age: 7, likes: ['LEGO', 'sharks'], role_notes: 'often the one with the idea' },
    { name: 'Phoenix', age: 4, likes: ['dinosaurs'], role_notes: 'gets the shout-along lines' },
  ],
  recurring: [
    {
      name: 'The magic red LEGO brick',
      type: 'device',
      rule: 'glows and clicks to start an adventure; returns them home at the end',
    },
  ],
  catchphrases: ['Play well', 'WHOOOOSH'],
  topics_covered: [{ topic: 'history of LEGO', story_id: null, date: '2026-09-25' }],
  last_story: {
    title: 'Cruz, Phoenix and the Brick That Clicked',
    ending: 'Back home, the final brick on their giant tower just went CLICK and held.',
  },
  tone_history: ['funny', 'exciting'],
  avoid: [],
}

/** The bible after the video-games story - what the soccer story was written against. */
const LENNON_BIBLE_AFTER_VIDEO_GAMES: StoryBible = {
  children: [
    {
      name: 'Lennon',
      age: 10,
      likes: ['Roblox', 'building games in Roblox Studio', 'soccer'],
      role_notes: 'Player One; builds rather than just plays',
    },
  ],
  recurring: [
    {
      name: 'Bit',
      type: 'character',
      rule: 'green 8-bit pixel guide; squeaky, jokes about being 8-bit; eyes go watery at the end',
    },
    {
      name: 'Golden coins',
      type: 'device',
      rule: 'one per saved level; fuse into a trophy at the end',
    },
  ],
  catchphrases: ['Player One', 'BZZZT', 'Level complete'],
  topics_covered: [{ topic: 'history of video games', story_id: null, date: '2026-09-26' }],
  last_story: {
    title: 'Lennon and the Lost Levels',
    ending:
      'A message on screen: THE NEXT LEVEL IS YOURS TO BUILD. Tomorrow he had a game to make.',
  },
  tone_history: ['exciting', 'funny'],
  avoid: [],
}

/** A second-story bible for the titanic scenario: sensitive topic AND continuity at once. */
const MAYA_BIBLE_AFTER_BRIDGES: StoryBible = {
  children: [
    { name: 'Maya', age: 7, likes: ['boats', 'drawing', 'swimming'], role_notes: 'asks why' },
  ],
  recurring: [
    {
      name: 'Barnacle the harbour seal',
      type: 'character',
      rule: 'guide; pops up out of the water with a fact and a bad pun; never rushes anyone',
    },
  ],
  catchphrases: ['All aboard, Maya', 'SPLOOSH'],
  topics_covered: [{ topic: 'how bridges are built', story_id: null, date: '2026-09-24' }],
  last_story: {
    title: 'Maya and the Bridge That Hummed',
    ending: 'Barnacle waved a flipper from the water as the last rivet went in.',
  },
  tone_history: ['calm', 'heart-warming'],
  avoid: ['another bridge'],
}

/** The eight F13 scenarios, in the order F13 lists them, then §6's four. */
export const SCENARIOS: EvalScenario[] = [
  {
    id: 'lego-band-a-pair',
    why: 'F13: band A pair on history-of-lego. The first reference story, first in a series.',
    suites: ['eval', 'bakeoff'],
    children: [CRUZ, PHOENIX],
    topic_input: 'how Lego was invented and the first kids who used it',
    topic_key: 'history-of-lego',
    tones: ['funny', 'exciting'],
    length_minutes: 10,
    bible: null,
    checks: {},
  },
  {
    id: 'video-games-band-c-solo',
    why: 'F13: band C solo on history-of-video-games. The other reference story, first in a series.',
    suites: ['eval', 'bakeoff'],
    children: [LENNON],
    topic_input: 'the history of computer gaming leading all the way to when Roblox was created',
    topic_key: 'history-of-video-games',
    tones: ['exciting', 'funny'],
    length_minutes: 10,
    bible: null,
    checks: {},
  },
  {
    id: 'sharks-band-a-continuity',
    why: 'F13: band A pair, second story on sharks. Tests series continuity against a real bible.',
    suites: ['eval', 'bakeoff'],
    children: [CRUZ, PHOENIX],
    topic_input: 'the history of sharks and different shark species',
    topic_key: 'sharks',
    tones: ['funny', 'exciting'],
    length_minutes: 10,
    bible: CRUZ_PHOENIX_BIBLE_AFTER_LEGO,
    checks: { continuity_reference: ['red LEGO brick', 'red brick', 'Play well', 'CLICK'] },
  },
  {
    id: 'soccer-band-c-continuity',
    why: 'F13: band C second story on history-of-soccer. Continuity with a guide character.',
    suites: ['eval', 'bakeoff'],
    children: [{ ...LENNON, notes: 'plays on a youth soccer team; practices penalties' }],
    topic_input: 'the history of soccer',
    topic_key: 'history-of-soccer',
    tones: ['exciting', 'funny'],
    length_minutes: 10,
    bible: LENNON_BIBLE_AFTER_VIDEO_GAMES,
    checks: { continuity_reference: ['Bit', 'Player One', 'coin', 'Level complete'] },
  },
  {
    id: 'volcanoes-mixed-ages',
    why: 'F13: mixed ages 4, 7 and 10 on volcanoes. Band follows the youngest; the 10-year-old still needs a hook per chapter.',
    suites: ['eval', 'bakeoff'],
    children: [
      { name: 'Phoenix', age: 4, likes: ['dinosaurs'], notes: null },
      { name: 'Cruz', age: 7, likes: ['LEGO', 'sharks'], notes: null },
      { name: 'Lennon', age: 10, likes: ['Roblox', 'soccer'], notes: null },
    ],
    topic_input: 'volcanoes and how they work',
    topic_key: 'volcanoes',
    tones: ['exciting', 'silly'],
    length_minutes: 10,
    bible: null,
    checks: {},
  },
  {
    id: 'bees-band-a-5min',
    why: 'F13: 5-minute band A on bees. The shortest target - tests that word targets scale.',
    suites: ['eval', 'bakeoff'],
    children: [PHOENIX],
    topic_input: 'bees and how honey is made',
    topic_key: 'bees',
    tones: ['silly', 'calm'],
    length_minutes: 5,
    bible: null,
    checks: {},
  },
  {
    id: 'space-race-band-c-15min',
    why: 'F13: 15-minute band C on space-race. The longest target - tests that length does not become padding.',
    suites: ['eval', 'bakeoff'],
    children: [LENNON],
    topic_input: 'the space race between the USA and the Soviet Union',
    topic_key: 'space-race',
    tones: ['exciting', 'mysterious'],
    length_minutes: 15,
    bible: null,
    checks: {},
  },
  {
    id: 'titanic-band-b',
    why: 'F13: a sensitive-but-allowed topic, band B. Must pass with scary_level <= 1.',
    suites: ['eval', 'bakeoff'],
    children: [{ name: 'Maya', age: 7, likes: ['boats', 'drawing', 'swimming'], notes: null }],
    topic_input: 'the Titanic',
    topic_key: 'the-titanic',
    tones: ['calm', 'heart-warming'],
    length_minutes: 10,
    bible: null,
    checks: { max_scary_level: 1 },
  },

  // --- JUDGE_AGENT.md §6: "the 8 from F13 plus 4 more chosen for difficulty".
  //
  // Two of §6's four name a topic and band that an F13 scenario already covers
  // (history-of-video-games, and the-titanic for band B). Repeating a scenario verbatim
  // would add cost and no information, so each of those four is given the *difficulty*
  // §6 asks for while differing from its F13 sibling in something that makes it harder:
  // a younger band for the legend, a series bible on top of the sad topic, a different
  // child for the notes scenario. Recorded in DECISIONS.md.
  {
    id: 'legend-video-games-band-b',
    why: '§6: a topic with a well-known legend (history-of-video-games). Band B rather than F13\'s band C, because hedging a legend in short sentences for a 7-year-old is harder than doing it wryly for a 10-year-old.',
    suites: ['bakeoff'],
    children: [{ name: 'Ada', age: 7, likes: ['Minecraft', 'drawing'], notes: null }],
    topic_input: 'the history of video games',
    topic_key: 'history-of-video-games',
    tones: ['funny', 'exciting'],
    length_minutes: 10,
    bible: null,
    checks: {},
  },
  {
    id: 'titanic-band-b-continuity',
    why: '§6: sad history handled gently for band B, this time as a second story in a series - the sensitive topic and the continuity rules have to hold at the same time.',
    suites: ['bakeoff'],
    children: [
      { name: 'Maya', age: 7, likes: ['boats', 'drawing', 'swimming'], notes: 'worries at bedtime' },
    ],
    topic_input: 'the Titanic',
    topic_key: 'the-titanic',
    tones: ['calm', 'heart-warming'],
    length_minutes: 10,
    bible: MAYA_BIBLE_AFTER_BRIDGES,
    checks: {
      max_scary_level: 1,
      continuity_reference: ['Barnacle', 'All aboard', 'SPLOOSH'],
    },
  },
  {
    id: 'magnets-band-a-thin',
    why: '§6: a topic with almost no narrative (how-magnets-work), band A. There is no history to hang chapters on, so the writer has to invent structure without inventing facts.',
    suites: ['bakeoff'],
    children: [PHOENIX],
    topic_input: 'how magnets work',
    topic_key: 'how-magnets-work',
    tones: ['silly', 'exciting'],
    length_minutes: 10,
    bible: null,
    checks: {},
  },
  {
    id: 'soccer-goalkeeper-notes',
    why: '§6: a topic where the parent notes must matter (history-of-soccer, notes "goalkeeper, hates losing"). A story that ignores the notes should visibly lose on the centre criterion.',
    suites: ['bakeoff'],
    children: [
      {
        name: 'Noah',
        age: 9,
        likes: ['soccer', 'goalkeeping gloves'],
        notes: 'goalkeeper, hates losing',
      },
    ],
    topic_input: 'the history of soccer',
    topic_key: 'history-of-soccer',
    tones: ['exciting', 'heart-warming'],
    length_minutes: 10,
    bible: null,
    checks: {},
  },
]

export function scenarioBand(s: EvalScenario): AgeBand {
  return bandForAges(s.children.map((c) => c.age))
}

export function scenarioTargetWords(s: EvalScenario): { min: number; max: number } {
  return targetWords({ band: scenarioBand(s), minutes: s.length_minutes })
}

export function evalScenarios(): EvalScenario[] {
  return SCENARIOS.filter((s) => s.suites.includes('eval'))
}

export function bakeoffScenarios(): EvalScenario[] {
  return SCENARIOS.filter((s) => s.suites.includes('bakeoff'))
}

/** `EVAL_SCENARIOS=all` or a comma-separated list of ids (the eval.yml workflow input). */
export function selectScenarios(all: EvalScenario[], spec: string | undefined): EvalScenario[] {
  const trimmed = (spec ?? 'all').trim()
  if (trimmed === '' || trimmed === 'all') return all
  const wanted = new Set(trimmed.split(',').map((s) => s.trim()).filter(Boolean))
  const picked = all.filter((s) => wanted.has(s.id))
  const unknown = [...wanted].filter((id) => !all.some((s) => s.id === id))
  if (unknown.length > 0) {
    throw new Error(
      `Unknown scenario id(s): ${unknown.join(', ')}. Known: ${all.map((s) => s.id).join(', ')}`,
    )
  }
  return picked
}

export function getScenario(id: string): EvalScenario {
  const found = SCENARIOS.find((s) => s.id === id)
  if (!found) throw new Error(`Unknown scenario "${id}"`)
  return found
}
