import { describe, expect, it } from 'vitest'
import {
  STORY_MAX_CHAPTERS,
  STORY_MIN_CHAPTERS,
  targetWords,
  wordCountWithinTolerance,
} from '@/lib/schemas'
import { syntheticStory } from '@/lib/eval/synthetic'
import { SCENARIOS, scenarioBand } from '@/lib/eval/scenarios'
import { narrativeWordCount } from '@/lib/eval/render'

/**
 * The assertion that was missing.
 *
 * `fitToRange()` guarded chapter trimming at `> 4`, so the 5-minute band A scenario
 * (`bees-band-a-5min`, 650-850 words) emerged with 4 chapters - outside the 6-10 range
 * §4.1.2 requires. Nothing failed, because no test validated a synthetic story's shape.
 *
 * A story generator whose output cannot satisfy the schema quietly weakens every test that
 * uses it: a scenario could fail the real gate for a reason the fixture invented. These run
 * over all 12 bake-off scenarios so the next short target cannot reintroduce it.
 */
describe('synthetic scenarios are schema-shaped', () => {
  const stories = SCENARIOS.map((scenario) => ({
    scenario,
    story: syntheticStory({ scenario, writingModel: 'claude-sonnet-5', sample: 1 }),
  }))

  it('covers all 12 bake-off scenarios', () => {
    expect(stories).toHaveLength(12)
  })

  it('every scenario produces 6-10 chapters', () => {
    for (const { scenario, story } of stories) {
      expect(story.chapters.length, `${scenario.id}`).toBeGreaterThanOrEqual(STORY_MIN_CHAPTERS)
      expect(story.chapters.length, `${scenario.id}`).toBeLessThanOrEqual(STORY_MAX_CHAPTERS)
    }
  })

  it('every scenario lands inside its band word target', () => {
    for (const { scenario, story } of stories) {
      const target = targetWords({
        band: scenarioBand(scenario),
        minutes: scenario.length_minutes,
      })
      const words = narrativeWordCount(story)
      expect(
        wordCountWithinTolerance(words, target),
        `${scenario.id}: ${words} words vs ${target.min}-${target.max}`,
      ).toBe(true)
    }
  })

  it('no chapter is left empty by the shrink path', () => {
    for (const { scenario, story } of stories) {
      for (const [i, chapter] of story.chapters.entries()) {
        expect(chapter.text.trim().length, `${scenario.id} chapter ${i}`).toBeGreaterThan(0)
        expect(chapter.heading.trim().length, `${scenario.id} chapter ${i}`).toBeGreaterThan(0)
      }
    }
  })

  it('is deterministic for a given scenario, model and sample', () => {
    for (const scenario of SCENARIOS.slice(0, 4)) {
      const a = syntheticStory({ scenario, writingModel: 'claude-sonnet-5', sample: 1 })
      const b = syntheticStory({ scenario, writingModel: 'claude-sonnet-5', sample: 1 })
      expect(JSON.stringify(a), scenario.id).toBe(JSON.stringify(b))
    }
  })

  /** The shortest target is where the old guard broke; assert it explicitly. */
  it('handles the 5-minute band A scenario, which is the tightest case', () => {
    const scenario = SCENARIOS.find((s) => s.id === 'bees-band-a-5min')
    expect(scenario, 'bees-band-a-5min scenario missing').toBeDefined()
    const story = syntheticStory({
      scenario: scenario!,
      writingModel: 'claude-sonnet-5',
      sample: 1,
    })
    expect(story.chapters.length).toBeGreaterThanOrEqual(STORY_MIN_CHAPTERS)
    const target = targetWords({ band: 'A', minutes: 5 })
    expect(wordCountWithinTolerance(narrativeWordCount(story), target)).toBe(true)
  })
})
