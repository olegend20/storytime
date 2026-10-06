/**
 * The words on lastten.org (issue #17).
 *
 * Kept as data so a test can hold them to two rules from the design brief: no claim about how
 * fast a story is made (generation time is not ours to promise), and nothing that reads as a
 * research finding, a statistic or an endorsement. Beliefs are written as beliefs. Every
 * promise names something the app already does; `feature` says where, for the same test.
 * Sending to a Kindle depends on the server having mail set up, so those two sentences are
 * separate and the page only says them when it is true.
 */
import { BRAND } from '@/lib/brand'

export const HERO = {
  eyebrow: BRAND.project,
  headline: ['Make the last ten minutes of the day the ones they ', 'remember.'] as const,
  lead:
    'A small project with one idea: end every day with a story. One where your child is the hero, ' +
    'and the world is something worth wondering about.',
  cta: 'Make tonight’s book',
  secondary: 'Read our mission',
  note: 'Free for families · Text-only stories · No adverts',
  moons: BRAND.tagline,
} as const

/** [before, the emphasised word, after] - a tuple, so an edit cannot silently lose the split. */
export const MISSION = [
  'To help parents and children end the day together — with a story, a little learning, and a ' +
    'moment that belongs to them. And to raise children who stay ',
  'curious',
  ' about the world, one bedtime at a time.',
] as const

export const BELIEFS: ReadonlyArray<{ n: string; title: string; body: string }> = [
  {
    n: 'i.',
    title: 'The last ten minutes are the ones that stay.',
    body:
      'The day is done and, for a few minutes, you have each other’s whole attention. We want ' +
      'that time to be easy to keep — even on the tired nights.',
  },
  {
    n: 'ii.',
    title: 'Stories are how children meet the world.',
    body:
      'Why the Moon shines. How a mountain becomes an island. A fact told inside a story, with ' +
      'your child in the middle of it, is one worth holding on to.',
  },
  {
    n: 'iii.',
    title: 'Curiosity is a habit.',
    body:
      'A child who falls asleep with a good question tends to wake up with another. Night after ' +
      'night, that adds up to someone who finds the world interesting.',
  },
]

export const HOW = {
  eyebrow: 'How it works',
  headline: 'A new book, about them, every night.',
  steps: [
    { title: 'Choose tonight’s heroes', body: 'Your children, by first name. Once they’re saved, it’s a single tap.' },
    {
      title: 'Pick something to wonder about',
      body: 'The Moon, the deep sea, why volcanoes erupt — or the question they asked at dinner.',
    },
    {
      title: 'Read it together',
      body: 'A story written for them, with a few true facts to talk about before lights out.',
    },
  ],
  aside: 'Then it lives in your library, free to read again.',
} as const

/** A fictional example, labelled as one on the page. Never a real child's name. */
export const SAMPLE = {
  label: 'A sample of a bedtime book',
  byline: 'A story starring Milo & Juno',
  title: 'Milo & Juno and the Moon’s Secret',
  paragraphs: [
    'Milo was pulling the blanket up, chin-high, when Juno noticed a little silver light on the windowsill.',
    '“I think the Moon has left us a question,” Juno whispered.',
  ],
  factLabel: 'A true fact from this story',
  fact: 'The Moon makes no light of its own. Moonlight is sunlight, bouncing off the Moon.',
} as const

export type PromiseFeature =
  | 'no-payment'
  | 'text-only'
  | 'child-data-minimal'
  | 'true-facts'
  | 'no-engagement-mechanics'
  | 'library'

export const PROMISES: ReadonlyArray<{ title: string; body: string; feature: PromiseFeature }> = [
  { title: 'Free for families', body: 'Free to make, free to reread.', feature: 'no-payment' },
  { title: 'Words, not screens', body: 'Text only. No videos, nothing to buy, no adverts.', feature: 'text-only' },
  {
    title: 'Only what a story needs',
    body: 'First name, age, what they love and how they read. Never a surname, a photo or a location.',
    feature: 'child-data-minimal',
  },
  {
    title: 'True facts, every time',
    body: 'Each story carries real things to learn, listed at the end to talk over.',
    feature: 'true-facts',
  },
  {
    title: 'Calm by design',
    body: 'No streaks, no badges, no notifications. It is bedtime.',
    feature: 'no-engagement-mechanics',
  },
  {
    title: 'Yours to keep',
    body: 'Every story is saved to your library, free to read again.',
    feature: 'library',
  },
]

const SCREEN_QUESTION = 'Do we need a screen at bedtime?'

/** Said only when this server can actually send to a Kindle (`kindleConfigured()`). */
export const KINDLE = {
  promiseTitle: 'Yours to keep',
  promise: ' It can be sent to a Kindle, too.',
  question: SCREEN_QUESTION,
  answer: ' If you would rather keep phones out of the bedroom, send the story to a Kindle.',
} as const

export const QUESTIONS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'How are the stories written?',
    a:
      'By an AI model, working inside guardrails written for young children: what a story may ' +
      'contain, how gentle it must be, and which facts it may use. You read it aloud, so the ' +
      'storyteller is always you.',
  },
  {
    q: 'What do you keep about my child?',
    a:
      'A first name, an age, the things they like, an optional reading level and any notes you ' +
      'choose to add, so the story can be about them. No surname, no birthday, no photo, no ' +
      'location. You can delete all of it at any time.',
  },
  {
    q: SCREEN_QUESTION,
    a: 'A phone in night mode works well: warm, dim, and it stays awake while you read.',
  },
  {
    q: 'Is it really free?',
    a:
      'Yes. There is a small nightly limit on new stories; rereading the ones in your library ' +
      'is unlimited.',
  },
]

export const CLOSING = {
  headline: ['Tonight, keep the last ', 'ten.'] as const,
  lead: BRAND.footer,
} as const

/** Every sentence a visitor can read, for the copy rules test. */
export function allLandingCopy(): string[] {
  return [
    HERO.eyebrow, HERO.headline.join(''), HERO.lead, HERO.cta, HERO.secondary, HERO.note, HERO.moons,
    MISSION.join(''),
    ...BELIEFS.flatMap((b) => [b.title, b.body]),
    HOW.eyebrow, HOW.headline, HOW.aside, ...HOW.steps.flatMap((s) => [s.title, s.body]),
    SAMPLE.label, SAMPLE.byline, SAMPLE.title, ...SAMPLE.paragraphs, SAMPLE.factLabel, SAMPLE.fact,
    ...PROMISES.flatMap((p) => [p.title, p.body]),
    ...QUESTIONS.flatMap((x) => [x.q, x.a]),
    CLOSING.headline.join(''), CLOSING.lead,
    KINDLE.promise, KINDLE.answer,
  ]
}
