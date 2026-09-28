import { countWords } from '@/lib/schemas'
import { narrativeWordCount } from './render'
import type { JudgeableStory } from './types'

/**
 * The four sabotaged calibration variants - JUDGE_AGENT.md §5.
 *
 * A judge that scores the references ≥ 4.5 has only shown it can say yes. These four show
 * it can say no, and say no for the *right reason*: one criterion collapses while the rest
 * of the story is untouched.
 *
 * Every function here fails loudly if its anchor text is missing. A sabotage that silently
 * does nothing is the worst possible outcome: calibration would pass because the story is
 * still good, and we would conclude the judge is discriminating when it is not. So each
 * edit asserts it matched, and each returns the evidence the calibration checker needs.
 */

export class SabotageError extends Error {
  constructor(message: string) {
    super(`${message}\nThe reference stories are the ground truth and must never be edited to make a sabotage apply (JUDGE_AGENT.md §5). Fix the sabotage instead.`)
    this.name = 'SabotageError'
  }
}

function mapChapters(
  story: JudgeableStory,
  fn: (text: string, index: number) => string,
): JudgeableStory {
  return { ...story, chapters: story.chapters.map((c, i) => ({ ...c, text: fn(c.text, i) })) }
}

// ---------------------------------------------------------------------------
// 1. Heroes: one child's name removed from all but one chapter
// ---------------------------------------------------------------------------

export interface HeroSabotage {
  story: JudgeableStory
  /** Chapter index that keeps the name. */
  keptChapter: number
  keptChapterHeading: string
  strippedFrom: number
  /** Expected: center <= 2 (§5). */
  expectation: 'center<=2'
}

/**
 * Removes a child's name from every chapter but one, rewriting the pair into a solo so the
 * prose still reads. The other child does all the doing; the removed child is still named
 * in the title and in the goodnight line, which is precisely the failure mode the rubric's
 * "2" describes: named but not driving anything.
 */
export function removeChildFromAllButOneChapter(
  story: JudgeableStory,
  opts: { remove: string; keepWith: string; keepChapter?: number },
): HeroSabotage {
  const keep = opts.keepChapter ?? 0
  const name = opts.remove
  const other = opts.keepWith
  const nameRe = new RegExp(`\\b${name}\\b`, 'g')

  const totalBefore = story.chapters.reduce(
    (n, c) => n + (c.text.match(nameRe)?.length ?? 0),
    0,
  )
  if (totalBefore === 0) throw new SabotageError(`"${name}" does not appear in any chapter.`)
  if (keep < 0 || keep >= story.chapters.length) {
    throw new SabotageError(`keepChapter ${keep} is out of range for ${story.chapters.length} chapters.`)
  }
  if ((story.chapters[keep]!.text.match(nameRe)?.length ?? 0) === 0) {
    throw new SabotageError(`chapter ${keep} does not mention "${name}", so it cannot be the one that keeps it.`)
  }

  let stripped = 0
  const sabotaged = mapChapters(story, (text, i) => {
    if (i === keep) return text
    const before = text.match(nameRe)?.length ?? 0
    if (before === 0) return text
    stripped += before
    return (
      text
        // Collapse the pair into a solo first, so no sentence is left with two subjects.
        .replace(new RegExp(`\\b${name}\\b and \\b${other}\\b`, 'g'), other)
        .replace(new RegExp(`\\b${other}\\b and \\b${name}\\b`, 'g'), other)
        .replace(nameRe, other)
        // Tidy up the artefacts the two passes leave behind.
        .replace(new RegExp(`\\b${other}\\b and \\b${other}\\b`, 'g'), other)
        .replace(new RegExp(`\\b${other}\\b, \\b${other}\\b`, 'g'), other)
        .replace(new RegExp(`"\\s*said ${other}\\.\\s*"`, 'g'), `" said ${other}. "`)
    )
  })

  const counts = sabotaged.chapters.map((c) => c.text.match(nameRe)?.length ?? 0)
  const remaining = counts.reduce((a, b) => a + b, 0)
  const chaptersNaming = counts.filter((n) => n > 0).length
  if (chaptersNaming !== 1) {
    throw new SabotageError(
      `expected "${name}" to survive in exactly 1 chapter, found ${chaptersNaming} (${remaining} mentions).`,
    )
  }

  return {
    story: sabotaged,
    keptChapter: keep,
    keptChapterHeading: story.chapters[keep]!.heading,
    strippedFrom: stripped,
    expectation: 'center<=2',
  }
}

// ---------------------------------------------------------------------------
// 2. Facts: three invented dates
// ---------------------------------------------------------------------------

export interface FactSabotage {
  story: JudgeableStory
  /** The wrong years the judge is expected to catch. §5 wants at least two named. */
  injectedDates: string[]
  details: { wrong: string; right: string; what: string }[]
  expectation: 'facts<=2 and evidence names >=2 injected dates'
}

/** Every pair must match somewhere, or the sabotage throws rather than half-applying. */
function replaceEverywhereOrThrow(
  story: JudgeableStory,
  pairs: { from: string; to: string }[],
): JudgeableStory {
  let out: JudgeableStory = {
    ...story,
    chapters: story.chapters.map((c) => ({ ...c })),
    true_facts: story.true_facts.map((f) => ({ ...f })),
  }
  for (const { from, to } of pairs) {
    let hits = 0
    const swap = (s: string): string => {
      const next = s.split(from).join(to)
      if (next !== s) hits += 1
      return next
    }
    out = {
      ...out,
      chapters: out.chapters.map((c) => ({ ...c, heading: swap(c.heading), text: swap(c.text) })),
      ending_line: swap(out.ending_line),
      true_facts: out.true_facts.map((f) => ({ ...f, text: swap(f.text) })),
    }
    if (hits === 0) throw new SabotageError(`anchor text not found: ${JSON.stringify(from)}`)
  }
  return out
}

/**
 * Three dates in the soccer story replaced with years that contradict the record, in the
 * prose, the level headings and the True Facts list. Nothing else changes, so a judge that
 * drops `facts` without dropping `craft` or `delight` is reading the facts and not the vibe.
 */
export function injectInventedDates(story: JudgeableStory): FactSabotage {
  const details = [
    { wrong: '1847', right: '1863', what: 'the founding of the Football Association' },
    { wrong: '1911', right: '1891', what: 'the penalty kick entering the rules' },
    { wrong: '1926', right: '1930', what: 'the first World Cup' },
  ]

  const sabotaged = replaceEverywhereOrThrow(story, [
    // Prose.
    { from: `"It's **1863**,"`, to: `"It's **1847**,"` },
    { from: 'In **1891**, soccer', to: 'In **1911**, soccer' },
    { from: '"**1930**," said Bit', to: '"**1926**," said Bit' },
    // Level headings.
    { from: '(London, 1863)', to: '(London, 1847)' },
    { from: 'Northern Ireland (1891)', to: 'Northern Ireland (1911)' },
    { from: '(Uruguay, 1930)', to: '(Uruguay, 1926)' },
    // True Facts list.
    { from: 'formed in 1863', to: 'formed in 1847' },
    { from: 'part of the rules in 1891', to: 'part of the rules in 1911' },
    { from: 'in Uruguay in 1930', to: 'in Uruguay in 1926' },
  ])

  return {
    story: sabotaged,
    injectedDates: details.map((d) => d.wrong),
    details,
    expectation: 'facts<=2 and evidence names >=2 injected dates',
  }
}

// ---------------------------------------------------------------------------
// 3. Age fit: a band A chase-and-ram sequence
// ---------------------------------------------------------------------------

export interface PerilSabotage {
  story: JudgeableStory
  replacedChapter: number
  replacedHeading: string
  wordCountBefore: number
  wordCountAfter: number
  /** True when the swap kept the story inside its band's length tolerance. */
  lengthUnchangedEnough: boolean
  expectation: 'age_fit<=2 for band A'
}

/**
 * Band A's rule is absolute: "none; nothing chases anyone" (§4.5), and GUARDRAILS.md §4.1
 * rule 3 forbids frightening content and unresolved dread. This REPLACES the great-white
 * chapter rather than adding one, so the word count barely moves: if the chapter were
 * appended, the word-count cap would pull `age_fit` down to 3 on its own and the test
 * would pass without the judge noticing the peril at all.
 */
export function injectGreatWhiteChase(story: JudgeableStory, chapterIndex: number): PerilSabotage {
  const target = story.chapters[chapterIndex]
  if (!target) throw new SabotageError(`chapter ${chapterIndex} does not exist.`)
  if (!/great white/i.test(target.heading) && !/great white/i.test(target.text)) {
    throw new SabotageError(
      `chapter ${chapterIndex} ("${target.heading}") is not the great-white chapter; ` +
        `refusing to sabotage the wrong one.`,
    )
  }

  const before = narrativeWordCount(story)
  const chaseText = [
    'Finally, out of the deep blue, came a shark the boys knew straight away. It was grey on top, white underneath, and its black eye rolled back as it turned.',
    '',
    'It did not swim slowly. It came straight at the window, faster and faster, and it did not stop.',
    '',
    '**BANG.**',
    '',
    'The whole submarine lurched sideways. Cruz smashed his shoulder into the wall. The lights flickered out, and for a long moment there was nothing but black water and the sound of something heavy circling.',
    '',
    '"It\'s behind us," whispered Phoenix. "It\'s right behind us."',
    '',
    '"Don\'t look," said Cruz. "Don\'t look, don\'t look, don\'t look."',
    '',
    'The great white rammed them again. **BANG.** A crack ran across the round window like a spider\'s leg. Water began to hiss in around the edge of the hatch, cold as ice, and the propeller made a horrible grinding noise and stopped.',
    '',
    'The shark chased them through the dark, all rows and rows of teeth, close enough that they could hear its skin scrape the yellow bricks. It herded them down, away from the light, into water so deep the boys could not see their own hands.',
    '',
    'Grandpa Greenie was nowhere. The radio was dead. Something bumped the hull from underneath, very gently, the way something does when it is deciding.',
    '',
    'The boys held on to each other and did not say anything at all.',
  ].join('\n')

  const sabotaged: JudgeableStory = {
    ...story,
    chapters: story.chapters.map((c, i) =>
      i === chapterIndex
        ? { ...c, heading: c.heading.replace(/:.*$/, ': The Chase'), text: chaseText }
        : { ...c },
    ),
  }

  const after = narrativeWordCount(sabotaged)
  return {
    story: sabotaged,
    replacedChapter: chapterIndex,
    replacedHeading: target.heading,
    wordCountBefore: before,
    wordCountAfter: after,
    lengthUnchangedEnough: Math.abs(after - before) <= 100,
    expectation: 'age_fit<=2 for band A',
  }
}

// ---------------------------------------------------------------------------
// 4. Age fit + delight: 900 words of padding
// ---------------------------------------------------------------------------

export interface PaddingSabotage {
  story: JudgeableStory
  wordsAdded: number
  wordCountBefore: number
  wordCountAfter: number
  /**
   * True when the padded story is STILL inside the band's ±15% tolerance, which is the
   * interesting case: the word-count cap does not fire, so `age_fit <= 3` has to come
   * from the judge noticing the padding rather than from arithmetic.
   */
  stillWithinLengthTolerance: boolean
  expectation: 'age_fit<=3 and delight not higher than the original'
}

/**
 * Repeated description, cycled so the repetition is unmistakable and appended to the body
 * of each chapter (never the cold open or the coda, so the opening and the landing stay
 * exactly as written and only the middle bloats).
 */
const PADDING_SENTENCES = [
  'The screen glowed in the dark room, and the glow was a soft glow, the kind of glow that glows softly in a dark room where a screen is glowing.',
  'Lennon looked at it for a while. Then he looked at it for a while longer, thinking about how long he had been looking at it, which was a while.',
  'It was, all things considered, a very interesting thing to look at, and it stayed interesting for as long as he kept looking at it, which was a while.',
  'The pixels were square. Each pixel was square, and next to each square pixel was another square pixel, and all of the square pixels together made a square picture.',
  'Bit hovered in the air, hovering the way a hovering thing hovers when it is hovering, which is to say he hovered there, hovering.',
  'Somewhere, far away, something beeped. Then it beeped again. The beeping went on beeping, beep after beep, until the beeps had all been beeped.',
]

export function padWithRepeatedDescription(
  story: JudgeableStory,
  extraWords = 900,
): PaddingSabotage {
  const before = narrativeWordCount(story)
  const bodies = story.chapters
    .map((_c, i) => i)
    .slice(1, Math.max(2, story.chapters.length - 1))
  if (bodies.length === 0) throw new SabotageError('story has no body chapters to pad.')

  const added: string[][] = story.chapters.map(() => [])
  let words = 0
  let cursor = 0
  while (words < extraWords) {
    const chapter = bodies[cursor % bodies.length]!
    const sentence = PADDING_SENTENCES[cursor % PADDING_SENTENCES.length]!
    added[chapter]!.push(sentence)
    words += countWords(sentence)
    cursor += 1
    if (cursor > 5_000) throw new SabotageError('padding loop failed to converge.')
  }

  const sabotaged: JudgeableStory = {
    ...story,
    chapters: story.chapters.map((c, i) => {
      const extra = added[i]!
      return extra.length === 0 ? { ...c } : { ...c, text: `${c.text}\n\n${extra.join(' ')}` }
    }),
  }

  const after = narrativeWordCount(sabotaged)
  return {
    story: sabotaged,
    wordsAdded: after - before,
    wordCountBefore: before,
    wordCountAfter: after,
    // Filled in by the caller, which knows the band's tolerance. Default false is
    // deliberately pessimistic; runCalibration() overwrites it.
    stillWithinLengthTolerance: false,
    expectation: 'age_fit<=3 and delight not higher than the original',
  }
}
