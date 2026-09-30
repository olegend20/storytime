import { describe, expect, it } from 'vitest'
import { loadManifest, loadReferenceStory, REFERENCE_DIR } from '@/lib/reference'
import { referenceStoryOutput } from '@/lib/quality/reference'
import { runDeterministicChecks } from '@/lib/quality/deterministic'
import { hasChildAction } from '@/lib/quality/actions'
import { scanBlocklist } from '@/lib/quality/blocklist'
import { targetWords, type AgeBand, type LengthMinutes } from '@/lib/schemas'

/**
 * F7 VT: "the four reference stories pass the deterministic gate when run with their
 * original inputs."
 *
 * This is the empirical validation of three heuristics that would otherwise be guesses:
 * the output blocklist (it must not flag "a tiny drop of blood" or "back from the dead"),
 * the child-action lexicon, and the cliffhanger-marker check. If any of them is wrong, the
 * gate would reject the very stories that define the bar - so this test is the one that
 * keeps them honest.
 *
 * Fact-mapping checks are skipped: the references predate fact packs and carry synthetic
 * ids (DECISIONS.md #22). The test asserts that the skip is REPORTED rather than silent.
 */

const manifest = loadManifest(REFERENCE_DIR)

describe('F7 deterministic gate vs. the reference stories', () => {
  for (const entry of manifest.stories) {
    it(`${entry.file} passes the deterministic gate with its original inputs`, () => {
      const parsed = loadReferenceStory(entry.file, REFERENCE_DIR)
      const story = referenceStoryOutput(parsed)
      const band = entry.request.age_band as AgeBand
      const minutes = entry.request.length_minutes as LengthMinutes

      const result = runDeterministicChecks({
        story,
        children: entry.request.children.map((c) => ({
          name: c.name,
          age: c.age ?? entry.request.youngest_age,
        })),
        band,
        minutes,
        targetWords: targetWords({ band, minutes }),
        factPack: null,
      })

      expect(
        result.failures.map((f) => f.detail),
        `${entry.file} gate failures`,
      ).toEqual([])
      expect(result.passed).toBe(true)
      // The fact-mapping checks could not run and must say so.
      expect(result.skipped.join(' ')).toContain('no fact pack supplied')
    })
  }

  it('folds headed cold opens and codas so every reference fits the 6-10 chapter cap', () => {
    for (const entry of manifest.stories) {
      const story = referenceStoryOutput(loadReferenceStory(entry.file, REFERENCE_DIR))
      expect(story.chapters.length, entry.file).toBeGreaterThanOrEqual(6)
      expect(story.chapters.length, entry.file).toBeLessThanOrEqual(10)
    }
  })

  it('counts the cold open, so the gate word count matches the reference word count', () => {
    for (const entry of manifest.stories) {
      const parsed = loadReferenceStory(entry.file, REFERENCE_DIR)
      const story = referenceStoryOutput(parsed)
      const band = entry.request.age_band as AgeBand
      const minutes = entry.request.length_minutes as LengthMinutes
      const result = runDeterministicChecks({
        story,
        children: entry.request.children.map((c) => ({
          name: c.name,
          age: c.age ?? entry.request.youngest_age,
        })),
        band,
        minutes,
        targetWords: targetWords({ band, minutes }),
        factPack: null,
      })
      // Markdown emphasis makes the two counts differ slightly; 3% is the tolerance.
      const drift = Math.abs(result.wordCount - parsed.narrativeWordCount)
      expect(drift / parsed.narrativeWordCount, entry.file).toBeLessThan(0.03)
    }
  })
})

describe('child-action heuristic, validated on the references', () => {
  it('every child in every reference story does something', () => {
    for (const entry of manifest.stories) {
      const parsed = loadReferenceStory(entry.file, REFERENCE_DIR)
      const text = parsed.chapters.map((c) => c.text).join('\n')
      for (const child of entry.request.children) {
        expect(hasChildAction(text, child.name), `${entry.file}: ${child.name}`).toBe(true)
      }
    }
  })

  it('speech and thought verbs alone do not count as an action', () => {
    expect(hasChildAction('"Sharks are the coolest," said Milo.', 'Milo')).toBe(false)
    expect(hasChildAction('Milo wondered about the tubes. Milo watched.', 'Milo')).toBe(false)
    expect(hasChildAction('Milo flipped a brick over.', 'Milo')).toBe(true)
  })
})

describe('output blocklist does not flag legitimate reference prose', () => {
  it('leaves the reference stories clean', () => {
    for (const entry of manifest.stories) {
      const parsed = loadReferenceStory(entry.file, REFERENCE_DIR)
      const text = [
        parsed.coldOpen,
        ...parsed.chapters.map((c) => `${c.heading}\n${c.text}`),
        parsed.endingLine ?? '',
        ...parsed.trueFacts,
      ].join('\n\n')
      expect(
        scanBlocklist(text).map((h) => h.match),
        entry.file,
      ).toEqual([])
    }
  })

  it('still catches the phrases it is there for', () => {
    expect(scanBlocklist('There was a dead body in the corner.').map((h) => h.match)).toContain(
      'dead body',
    )
    expect(scanBlocklist('He picked up the gun.').map((h) => h.match)).toContain('gun')
    expect(scanBlocklist('She kissed him goodnight.').map((h) => h.match)).toContain('kissed')
  })

  it('allowlists the phrases that would otherwise be false positives', () => {
    for (const clean of [
      'A killer whale swam past.',
      'It was a dead end.',
      'Mario brought video games back from the dead.',
      'Red blood cells carry oxygen.',
      'They can smell a tiny drop of blood from very far away.',
      'The shot kissed the crossbar.',
      'Scunthorpe United won on penalties.',
      'A shooting star crossed the sky.',
      'The workshop burned down in 1942, and Ole rebuilt it.',
      'Megalodon died out millions of years ago.',
      'People are often scared of sharks.',
    ]) {
      expect(scanBlocklist(clean).map((h) => h.match), clean).toEqual([])
    }
  })
})
