import { describe, expect, it } from 'vitest'
import { asStoryOutput, loadManifest, loadReferenceStory, referenceStoryFiles } from '@/lib/reference'
import { scanStoryStructure, scanStoryText } from '@/lib/guardrails/output'
import { MAX_SCARY_LEVEL } from '@/lib/schemas/common'
import { runOutputGate } from '@/lib/guardrails/gate'

/**
 * The calibration test that keeps the L4 deterministic scanner honest.
 *
 * The four reference stories set the quality bar and are prose this lane did not write.
 * They contain, among other things, "a tiny drop of blood", "people who liked shooting
 * things", "Mario started life as Jumpman", a workshop burning down in a band A story,
 * "brought video games back from the dead" and two mentions of a "secret". If the output
 * gate flags any of that, the gate is wrong - not the stories.
 *
 * This is the independent counterpart to test/guardrails/corpus-output.test.ts, where both
 * the excerpts and the patterns were authored by the same lane.
 */

const manifest = loadManifest()
const files = referenceStoryFiles()

describe('s4.2 deterministic output checks vs the reference stories', () => {
  it('has all four reference stories to calibrate against', () => {
    expect(files.length).toBe(4)
  })

  for (const file of files) {
    const parsed = loadReferenceStory(file)
    const story = asStoryOutput(parsed)
    const entry = manifest.stories.find((s) => s.file === file)
    const childNames = entry?.request.children.map((c) => c.name) ?? []

    it(`${file} has zero hard violations`, () => {
      const scan = scanStoryStructure(story, { childNames })
      const detail = scan.violations
        .filter((v) => v.severity === 'hard')
        .map((v) => `rule ${v.rule}: ${v.quote}`)
        .join('\n')
      expect(scan.violations.filter((v) => v.severity === 'hard').length, detail).toBe(0)
    })

    it(`${file} passes the output gate when the safety review is clean`, async () => {
      const band = entry?.request.age_band ?? 'A'
      const result = await runOutputGate({
        story,
        band,
        childNames,
        attempt: 1,
        review: async () => ({
          review: {
            safe: true,
            violations: [],
            scary_level: MAX_SCARY_LEVEL[band],
            positive_portrayal: true,
            ending_safe: true,
          },
          costUsd: 0,
        }),
      })
      expect(result.outcome, JSON.stringify(result.hardViolations)).toBe('pass')
    })

    it(`${file} produces only soft signals, if any`, () => {
      const scan = scanStoryText(parsed.chapters.map((c) => c.text).join('\n\n'))
      // Soft signals are expected and useful (they are passed to the Haiku review);
      // the assertion is only that they never become a hard fail on their own.
      expect(scan.hardViolations.length).toBe(0)
      console.log(
        `[guardrails] ${file}: ${scan.violations.length} soft signal(s) -> ${
          scan.violations.map((v) => `rule ${v.rule}`).join(', ') || 'none'
        }`,
      )
    })
  }

  it('does not flag the rule 7 factual-mention boundary', () => {
    const allowed = 'Mario started life as Jumpman, and Theo jumped Jumpman over the barrels.'
    expect(scanStoryText(allowed).hardViolations).toEqual([])
    const breach = 'Then Mario waved at them and said hello.'
    expect(scanStoryText(breach).hardViolations.map((v) => v.rule)).toContain(7)
  })

  it('does not flag a gently-told historical fire for band A', () => {
    const lego =
      '"FIRE! The workshop is on fire!" Orange flames danced in the dark. Milo grabbed ' +
      "Juno's hand, and they ran outside with everyone else."
    expect(scanStoryText(lego).hardViolations).toEqual([])
  })

  it('does not flag "a tiny drop of blood" but does flag blood in a violent context', () => {
    expect(scanStoryText('They can smell a tiny drop of blood from very far away.').hardViolations)
      .toEqual([])
    expect(
      scanStoryText('He was covered in blood and the wound would not close.').hardViolations.map(
        (v) => v.rule,
      ),
    ).toContain(2)
  })
})
