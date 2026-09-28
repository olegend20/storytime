import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bandForAge,
  countWords,
  targetWords,
  wordCountWithinTolerance,
  MAX_CHAPTER_WORD_SHARE,
  MIN_CHILD_CHAPTER_COVERAGE,
  StoryOutput,
} from '@/lib/schemas'
import { asStoryOutput, loadManifest, loadReferenceStory } from '@/lib/reference'

/**
 * The four reference stories are load-bearing - they define the quality bar and are
 * required by:
 *   - IMPLEMENTATION_PLAN.md s4.1.8 - style anchors in the master prompt
 *   - JUDGE_AGENT.md s5 - every row of the judge calibration set
 *   - F13 AC - "judge calibration set passes before results count"
 *   - F7 VT - the four stories pass the deterministic gate
 *   - F5 VT - live fact packs contain the anchor facts from their True Facts lists
 *
 * They arrived on 2026-09-27 and this test is now merge-blocking: if they are ever
 * removed or truncated, calibration silently loses its ground truth. Never satisfy it
 * with model-written substitutes - calibrating the judge against stories we generated and
 * then grading our own output with that judge measures nothing.
 */

const DIR = join(process.cwd(), 'storytime-plan', 'reference-stories')

function referenceStories(): string[] {
  if (!existsSync(DIR)) return []
  // README.md is our own placeholder note, not a reference story.
  return readdirSync(DIR).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
}

export const REFERENCE_STORIES_PRESENT = referenceStories().length >= 4

describe('reference stories (quality bar)', () => {
  it('four reference stories are present in storytime-plan/reference-stories/', () => {
    const found = referenceStories()
    expect(
      found.length,
      `Found ${found.length} reference story file(s) in storytime-plan/reference-stories/, expected 4.\n` +
        `They were missing from the handover archive (files (1).zip contained only the three\n` +
        `planning documents). Blocked until they arrive:\n` +
        `  - master prompt style anchors (IMPLEMENTATION_PLAN.md s4.1.8)\n` +
        `  - judge calibration (JUDGE_AGENT.md s5) and therefore the F13 eval gate\n` +
        `  - F7 VT: reference stories pass the deterministic gate\n` +
        `Everything else in F1-F15 proceeds without them.`,
    ).toBeGreaterThanOrEqual(4)
  })

  it.runIf(REFERENCE_STORIES_PRESENT)('each story has enough prose to anchor style on', () => {
    for (const file of referenceStories()) {
      const words = readFileSync(join(DIR, file), 'utf8').trim().split(/\s+/).length
      expect(words, file).toBeGreaterThan(800)
    }
  })

  it.runIf(REFERENCE_STORIES_PRESENT)('the anchor facts named in F5 appear across the set', () => {
    const corpus = referenceStories()
      .map((f) => readFileSync(join(DIR, f), 'utf8'))
      .join('\n')
      .toLowerCase()
    // F5 VT names these explicitly as fact-pack anchor facts.
    for (const anchor of ['leg godt', '1958', 'mccrum', 'pickles']) {
      expect(corpus, `anchor fact "${anchor}" not found in reference stories`).toContain(anchor)
    }
  })
})

describe('reference-stories manifest', () => {
  const manifestPath = join(DIR, 'manifest.json')

  // loadManifest() validates against the ReferenceManifest zod schema, so these
  // assertions also prove the manifest's own shape.
  const manifest = () => loadManifest(DIR)

  it('exists, so the judge can score each story with its real inputs', () => {
    expect(existsSync(manifestPath), 'storytime-plan/reference-stories/manifest.json missing').toBe(true)
  })

  it('has an entry per story file, and every entry points at a real file', () => {
    const m = manifest()
    expect(m.stories).toHaveLength(4)
    for (const story of m.stories) {
      expect(existsSync(join(DIR, story.file)), story.file).toBe(true)
    }
  })

  it('names the model that wrote them, which is bake-off contestant 4', () => {
    // JUDGE_AGENT.md s6: "the model that wrote the reference stories" is a contestant.
    expect(manifest().written_by_model).toBe('claude-fable-5-1')
  })

  /** JUDGE_AGENT.md s5 needs two continuity pairs to test the bible against. */
  it('covers two series, each with a first and a second story', () => {
    const m = manifest()
    const bySeries = new Map<string, number[]>()
    for (const s of m.stories) {
      bySeries.set(s.series, [...(bySeries.get(s.series) ?? []), s.sequence])
    }
    expect([...bySeries.keys()].sort()).toEqual(['cruz-phoenix', 'lennon'])
    for (const [series, sequences] of bySeries) {
      expect(sequences.sort(), series).toEqual([1, 2])
    }
  })

  /** A sequence-1 story has no prior bible; a sequence-2 story must have one. */
  it('gives every second story a bible_before and every first story none', () => {
    for (const story of manifest().stories) {
      if (story.sequence === 1) expect(story.bible_before, story.file).toBeNull()
      else expect(story.bible_before, story.file).not.toBeNull()
    }
  })

  it('records a band and a length for every story, matching our own band mapping', () => {
    for (const story of manifest().stories) {
      expect(['A', 'B', 'C', 'D']).toContain(story.request.age_band)
      expect([5, 10, 15]).toContain(story.request.length_minutes)
      // The manifest's declared band must agree with bandForAge on the youngest child.
      expect(bandForAge(story.request.youngest_age), story.file).toBe(story.request.age_band)
    }
  })

  /**
   * Counted the way the gate counts - cold open + chapter bodies + ending line, excluding
   * headings and the True Facts list. Raw file word counts overstate length by ~12% and
   * would wrongly flag the shark story; this independently validates the narrative-only
   * definition in DECISIONS.md #9.
   */
  it('each story falls within its band word target, +/- the gate tolerance', () => {
    for (const story of manifest().stories) {
      const parsed = loadReferenceStory(story.file, DIR)
      const target = targetWords({
        band: story.request.age_band,
        minutes: story.request.length_minutes,
      })
      expect(
        wordCountWithinTolerance(parsed.narrativeWordCount, target),
        `${story.file}: ${parsed.narrativeWordCount} narrative words, target ${target.min}-${target.max} (+/-15%)`,
      ).toBe(true)
    }
  })

  it('parses every story into the structure the gate and judge expect', () => {
    for (const story of manifest().stories) {
      const parsed = loadReferenceStory(story.file, DIR)
      expect(parsed.title.length, `${story.file} title`).toBeGreaterThan(0)
      /**
       * s4.1.2 asks for 6-10 chapters, each a "stop" on the journey. Two of the four
       * references additionally give their cold open and/or their return-home coda a
       * heading of its own ("Loading...", "Kickoff", "Game Over? Not Quite.", "Full
       * Time"), so their headed-section count runs one or two above the journey-stop
       * count. Generated stories fold the cold open into chapters[0] instead
       * (DECISIONS.md #18), which is why StoryOutput caps chapters at 10 while the
       * markdown references may carry up to 12 headed sections.
       */
      expect(parsed.chapters.length, `${story.file} headed sections`).toBeGreaterThanOrEqual(6)
      expect(parsed.chapters.length, `${story.file} headed sections`).toBeLessThanOrEqual(12)
      // s4.1.2: every story ends on a bedtime-appropriate line.
      expect(parsed.endingLine, `${story.file} ending line`).toBeTruthy()
      // F7: >= 8 true facts.
      expect(parsed.trueFacts.length, `${story.file} true facts`).toBeGreaterThanOrEqual(8)
      // Every chapter must have a body, not just a heading.
      for (const ch of parsed.chapters) {
        expect(ch.text.length, `${story.file} / ${ch.heading}`).toBeGreaterThan(0)
      }
    }
  })

  /** F7 deterministic check: no chapter may exceed 40% of total words. */
  it('no reference story has a runaway chapter', () => {
    for (const story of manifest().stories) {
      const parsed = loadReferenceStory(story.file, DIR)
      const counts = parsed.chapters.map((c) => countWords(c.text))
      const total = counts.reduce((a, b) => a + b, 0)
      const largest = Math.max(...counts)
      expect(largest / total, `${story.file} largest chapter share`).toBeLessThan(
        MAX_CHAPTER_WORD_SHARE,
      )
    }
  })

  /** Every selected child must appear by name in >= 60% of chapters (F6 AC). */
  it('every child appears in at least 60% of chapters of their story', () => {
    for (const story of manifest().stories) {
      const parsed = loadReferenceStory(story.file, DIR)
      for (const child of story.request.children) {
        const hits = parsed.chapters.filter((c) => c.text.includes(child.name)).length
        const coverage = hits / parsed.chapters.length
        expect(
          coverage,
          `${story.file}: ${child.name} appears in ${hits}/${parsed.chapters.length} chapters`,
        ).toBeGreaterThanOrEqual(MIN_CHILD_CHAPTER_COVERAGE)
      }
    }
  })
})

/**
 * Regression guards for two bugs lane 5 caught in lib/reference.ts.
 *
 * `asStoryOutput()` dropped the cold open entirely (110 words of the LEGO story, 251 of the
 * shark story), and the subtitle leaked into the cold-open prose because a blank line
 * counted as content. Together they meant the judge would have scored "Story craft" on a
 * story that began at Chapter 1, and "Series continuity" on a shark story whose opening
 * callback to the previous night had been deleted - systematically under-scoring the very
 * stories calibration trusts as the bar.
 */
describe('reference stories convert to StoryOutput faithfully', () => {
  it('every reference validates against StoryOutput', () => {
    for (const story of loadManifest(DIR).stories) {
      const out = asStoryOutput(loadReferenceStory(story.file, DIR))
      const parsed = StoryOutput.safeParse(out)
      expect(
        parsed.success,
        `${story.file}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues[0])}`,
      ).toBe(true)
    }
  })

  it('folds the cold open into chapters[0] rather than dropping it (DECISIONS #18)', () => {
    for (const story of loadManifest(DIR).stories) {
      const parsed = loadReferenceStory(story.file, DIR)
      const out = asStoryOutput(parsed)
      const firstChapter = out.chapters[0]!.text
      if (parsed.coldOpen !== '') {
        expect(firstChapter.startsWith(parsed.coldOpen), `${story.file}`).toBe(true)
      }
      // No conversion may lose narrative words.
      const converted =
        out.chapters.reduce((n, c) => n + countWords(c.text), 0) + countWords(out.ending_line)
      expect(converted, `${story.file} words after conversion`).toBeGreaterThanOrEqual(
        parsed.narrativeWordCount,
      )
    }
  })

  it('keeps the subtitle out of the prose', () => {
    for (const story of loadManifest(DIR).stories) {
      const parsed = loadReferenceStory(story.file, DIR)
      expect(parsed.subtitle, `${story.file} subtitle`).toBeTruthy()
      expect(parsed.coldOpen, `${story.file} cold open`).not.toContain(parsed.subtitle!)
      expect(asStoryOutput(parsed).chapters[0]!.text).not.toContain(parsed.subtitle!)
    }
  })

  /** Each story opens in the child's real world, not mid-adventure (§4.1.2). */
  it('opens chapter 1 in the real world', () => {
    const openings = Object.fromEntries(
      loadManifest(DIR).stories.map((s) => [
        s.file,
        asStoryOutput(loadReferenceStory(s.file, DIR)).chapters[0]!.text.slice(0, 120),
      ]),
    )
    expect(openings['cruz-and-phoenix-lego-story.md']).toContain('rainy Saturday')
    expect(openings['cruz-and-phoenix-shark-submarine.md']).toContain('magic red brick')
    expect(openings['lennon-and-the-lost-levels.md']).toContain('supposed to be asleep')
    expect(openings['lennon-the-beautiful-game.md']).toContain('practicing penalties')
  })

  /**
   * The second story of each series must reference a prior recurring element in its
   * opening - the continuity property F4's eval and the judge's criterion 5 both check.
   */
  it('second stories carry a continuity callback in chapter 1', () => {
    for (const story of loadManifest(DIR).stories.filter((s) => s.sequence === 2)) {
      const firstChapter = asStoryOutput(loadReferenceStory(story.file, DIR)).chapters[0]!.text
      const bible = story.bible_before as { recurring?: { name: string }[] } | null
      const names = (bible?.recurring ?? []).map((r) => r.name)
      expect(names.length, `${story.file} has no prior recurring elements`).toBeGreaterThan(0)
      const referenced = names.some((n) =>
        n
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .some((w) => firstChapter.toLowerCase().includes(w)),
      )
      expect(referenced, `${story.file} chapter 1 references none of: ${names.join(', ')}`).toBe(true)
    }
  })
})
