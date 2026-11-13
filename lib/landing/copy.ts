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

/**
 * The coming-soon page (issue #92): what lastten.org says while places open a few at a time.
 * The same rules as the rest of the page apply, and the same test reads it.
 */
export const COMING_SOON = {
  eyebrow: 'Coming soon',
  headline: ['Turn the last ten minutes of the day into the part you both ', 'love.'] as const,
  lead:
    'A bedtime story where your child is the hero, about whatever they wonder about. Ten quiet ' +
    'minutes together that leave you both a little more curious.',
  joinLabel: 'Email for the waitlist',
  joinButton: 'Join the waitlist',
  joining: 'Adding you…',
  note: 'We are opening places a few families at a time, and will email you when yours is ready.',
  privacy: 'We use your address only for that. No newsletters, no sharing.',
  // Issue #95: joining sends a link; the address is on the list once it is confirmed.
  joinedTitle: 'Check your email.',
  joinedBody: 'We have sent you a link to confirm your place. If it is not in your inbox, look in spam.',
  joinError: 'We could not add you just now. Please try again in a moment.',
  badEmail: 'Please enter an email address we can write to.',
  signIn: 'Already have a place? Sign in',
  shelf: {
    eyebrow: 'Why we are building it',
    headline: ['No encyclopedia on the shelf? Tonight’s story ', 'is one.'] as const,
    body:
      'There may be no encyclopedia in the house any more, but there is still bedtime. Let the ' +
      'story be where your child learns about anything their mind can imagine: the deep sea, ' +
      'the Moon, how a bee makes honey, the question they asked at dinner.',
  },
  points: [
    { title: 'For your child', body: 'A story with them at the centre, and something true to wonder about.' },
    { title: 'For you', body: 'An easy, lovely way to end the day, even on the tired nights.' },
    { title: 'For both of you', body: 'Something new to talk about before the light goes out.' },
  ],
  more: 'Read more about the project',
  /** /waitlist/confirm (issue #95): the page the emailed link opens. */
  confirm: {
    eyebrow: 'The waitlist',
    title: 'Confirm your place',
    body: 'One press and you are on the list.',
    button: 'Confirm my place',
    confirming: 'Confirming…',
    doneTitle: 'You’re on the list.',
    doneBody: 'We’ll email you when your place is ready. Sleep well.',
    badTitle: 'That link has expired or was already used.',
    badBody: 'If you pressed Confirm before, you are already on the list. If not, join again and we will send a fresh link.',
    again: 'Join the waitlist',
    error: 'We could not confirm that just now. Please try again in a moment.',
  },
} as const

/**
 * The words in our emails (issue #98), held to the same rules as the pages. Each email is one
 * action with one button, then a little of the project's own words. Sign-in mail is sent by
 * Supabase from supabase/templates/, which are generated from these (lib/email/auth-templates.ts).
 */
export const EMAIL = {
  confirm: {
    subject: `Confirm your place on the waitlist for ${BRAND.wordmark}`,
    preheader: 'One press and you are on the list.',
    eyebrow: 'The waitlist',
    headline: ['One press and you are ', 'on the list.'] as const,
    lead: `Someone, hopefully you, asked to join the waitlist for ${BRAND.wordmark} with this address. Confirm it was you and we will keep your place.`,
    button: 'Confirm my place',
    note: 'The link works for 7 days. We will email you again when your place is ready.',
    reason: 'If this was not you, ignore this email and we will forget the address.',
  },
  invite: {
    subject: `You’re in: your place at ${BRAND.wordmark} is ready`,
    preheader: 'Thank you for waiting. Tonight’s bedtime story can star your child.',
    eyebrow: 'Your place is ready',
    headline: ['Tonight, the last ten minutes ', 'are theirs.'] as const,
    lead: `Thank you for waiting. Your place at ${BRAND.wordmark} is open: a bedtime story where your child is the hero, with something true to wonder about.`,
    button: 'Start tonight’s story',
    chips: 'Free for families · No password · No adverts',
    note: 'Use this email address and we will send you a sign-in link. There is nothing to remember.',
    reason: `You joined the waitlist for ${BRAND.wordmark} with this address.`,
    help: 'Questions? Our answers are at',
    /** The site's own sample (SAMPLE), labelled as one. Never a real child's name. */
    sample: {
      eyebrow: 'A peek at tonight',
      title: ['A book with your child ', 'in it.'] as const,
      label: SAMPLE.label,
      bookTitle: SAMPLE.title,
      byline: SAMPLE.byline,
      paragraphs: SAMPLE.paragraphs,
      factLabel: SAMPLE.factLabel,
      fact: SAMPLE.fact,
      caption: 'Yours will star your own children, by first name, and end with a few true facts to talk about.',
    },
    promisesEyebrow: 'What you can count on',
    promises: PROMISES.filter((p) =>
      (['no-payment', 'text-only', 'no-engagement-mechanics', 'child-data-minimal'] as PromiseFeature[]).includes(p.feature),
    ),
    close: ['Tonight, keep the last ', 'ten.'] as const,
  },
  signIn: {
    subject: `Your sign-in link for ${BRAND.wordmark}`,
    preheader: 'Press the button to sign in. No password needed.',
    eyebrow: 'Sign in',
    headline: ['Your sign-in link ', 'is here.'] as const,
    lead: 'Press the button to sign in. There is no password to remember.',
    button: 'Sign in',
    note: 'The link works once and expires after a short while. You can always ask for a new one.',
    reason: 'If you did not ask to sign in, ignore this email. Nothing changes.',
  },
  /** Below the button: why the project exists, in the coming-soon page's words. */
  why: {
    eyebrow: COMING_SOON.shelf.eyebrow,
    title: COMING_SOON.shelf.headline,
    body: COMING_SOON.shelf.body,
    points: COMING_SOON.points,
  },
  /** Below the invite's button: the first night, step by step. */
  how: {
    eyebrow: HOW.eyebrow,
    title: ['A new book, about them, ', 'every night.'] as const,
    body: HOW.aside,
    points: HOW.steps,
  },
  /** Below the sign-in button: one quiet line, so a link email is still ours. */
  tonight: {
    eyebrow: BRAND.project,
    title: ['Tonight, keep the last ', 'ten.'] as const,
    body: 'A story with them at the centre, and something true to talk about before the light goes out.',
  },
} as const

/** Every sentence a visitor can read, for the copy rules test. */
export function allLandingCopy(): string[] {
  return [
    COMING_SOON.eyebrow, COMING_SOON.headline.join(''), COMING_SOON.lead, COMING_SOON.joinLabel,
    COMING_SOON.joinButton, COMING_SOON.joining, COMING_SOON.note, COMING_SOON.privacy,
    COMING_SOON.joinedTitle, COMING_SOON.joinedBody, COMING_SOON.joinError, COMING_SOON.badEmail,
    COMING_SOON.signIn, COMING_SOON.shelf.eyebrow, COMING_SOON.shelf.headline.join(''),
    COMING_SOON.shelf.body, ...COMING_SOON.points.flatMap((p) => [p.title, p.body]), COMING_SOON.more,
    ...Object.values(COMING_SOON.confirm),
    HERO.eyebrow, HERO.headline.join(''), HERO.lead, HERO.cta, HERO.secondary, HERO.note, HERO.moons,
    MISSION.join(''),
    ...BELIEFS.flatMap((b) => [b.title, b.body]),
    HOW.eyebrow, HOW.headline, HOW.aside, ...HOW.steps.flatMap((s) => [s.title, s.body]),
    SAMPLE.label, SAMPLE.byline, SAMPLE.title, ...SAMPLE.paragraphs, SAMPLE.factLabel, SAMPLE.fact,
    ...PROMISES.flatMap((p) => [p.title, p.body]),
    ...QUESTIONS.flatMap((x) => [x.q, x.a]),
    CLOSING.headline.join(''), CLOSING.lead,
    KINDLE.promise, KINDLE.answer,
    ...[EMAIL.confirm, EMAIL.invite, EMAIL.signIn].flatMap((m) => [
      m.subject, m.preheader, m.eyebrow, m.headline.join(''), m.lead, m.button, m.note, m.reason,
    ]),
    EMAIL.how.title.join(''), EMAIL.tonight.title.join(''), EMAIL.tonight.body,
    EMAIL.invite.chips, EMAIL.invite.help, EMAIL.invite.sample.eyebrow, EMAIL.invite.sample.title.join(''),
    EMAIL.invite.sample.caption, EMAIL.invite.promisesEyebrow, EMAIL.invite.close.join(''),
  ]
}
