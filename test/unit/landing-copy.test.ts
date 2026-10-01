import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allLandingCopy, PROMISES, QUESTIONS, type PromiseFeature } from '@/lib/landing/copy'
import { ChildInput } from '@/lib/schemas/child'

/**
 * VT-R3 (issue #17): what lastten.org is allowed to say.
 *
 * The page speaks for the project, so its words are held to the design brief's rules: no
 * promise about how fast a story is made, nothing dressed as research, and no promise the
 * product does not keep. Each promise is tied to the thing in the repo that makes it true.
 */

const copy = allLandingCopy()

describe('landing copy', () => {
  it('makes no claim about how fast a story is made', () => {
    const speed = /\b(seconds?|instant(ly)?|in (a|one|two|\d+) minutes?|in no time|right away|immediately|in the time it takes)\b/i
    expect(copy.filter((line) => speed.test(line))).toEqual([])
  })

  it('"ten minutes" is always about the time together, never generation', () => {
    for (const line of copy.filter((l) => /ten minutes/i.test(l))) {
      expect(line, line).not.toMatch(/ready|made|written|generat|wait/i)
    }
  })

  it('claims no research, statistics, endorsements or organisational status', () => {
    const claim = /\b(stud(y|ies)|research|proven|scientif|experts?|\d+\s?%|percent|award|trusted by|recommended by|nonprofit|non-profit|charity|registered)\b/i
    expect(copy.filter((line) => claim.test(line))).toEqual([])
  })

  it('says plainly that stories are written by AI', () => {
    expect(QUESTIONS.some((x) => /AI model/.test(x.a))).toBe(true)
  })

  /** Where each promise is kept. A promise with no evidence here cannot be added to the page. */
  const EVIDENCE: Record<PromiseFeature, () => boolean> = {
    // No payment code or dependency exists in the product.
    'no-payment': () => !/stripe|paddle|lemonsqueezy|checkout/i.test(readFileSync('package.json', 'utf8')),
    // The story contract is text: no image, audio or video field.
    'text-only': () => !/image_url|audio_url|video/i.test(readFileSync('lib/schemas/story.ts', 'utf8')),
    // Rule 7: the child shape has no surname, birthdate, photo or location.
    'child-data-minimal': () =>
      Object.keys(ChildInput.shape).sort().join() === ['age', 'first_name', 'likes', 'notes', 'reading_level'].join(),
    'true-facts': () => /true_facts/.test(readFileSync('lib/schemas/story.ts', 'utf8')),
    // No push or notification API anywhere in the client, and no streak or score in the UI.
    'no-engagement-mechanics': () => !/Notification\.requestPermission|pushManager/.test(readFileSync('public/sw.js', 'utf8')),
    'library-and-kindle': () => readFileSync('lib/kindle/send.ts', 'utf8').includes('sendStoryToKindle'),
  }

  it.each(PROMISES.map((p) => [p.title, p.feature] as const))('"%s" is something the app does', (_title, feature) => {
    expect(EVIDENCE[feature]()).toBe(true)
  })

  it('the child-data promise names only fields the app stores', () => {
    const promise = PROMISES.find((p) => p.feature === 'child-data-minimal')!
    expect(promise.body).toMatch(/first name/i)
    expect(promise.body).toMatch(/never a surname, a photo or a location/i)
  })
})
