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

  it('flags neither a mention nor a character taking part (rule 7 retired 2026-10-08)', () => {
    const mention = 'Mario started life as Jumpman, and Theo jumped Jumpman over the barrels.'
    expect(scanStoryText(mention).hardViolations).toEqual([])
    const takingPart = 'Then Mario waved at them and said hello.'
    expect(scanStoryText(takingPart).hardViolations).toEqual([])
  })

  it('rule 10 in code: a child touching a wild animal, or a secret from a grown-up (missed by L4 in whole stories, 2026-10-08)', () => {
    const r10 = (t: string) => scanStoryText(t).hardViolations.filter((v) => v.rule === 10).length
    expect(r10('The nurse shark rested on the sand. "You can touch its skin, gently, with one finger," said Finn.')).toBe(1)
    expect(r10('Juno reached out and patted the whale shark. It was soft as a pool float.')).toBe(1)
    expect(r10('Milo rode the dolphin across the bay.')).toBe(1)
    expect(r10('It was way past bedtime. Shh, don\'t tell Mom.')).toBe(1)
    expect(r10('We will keep it a secret from the grown-ups.')).toBe(1)
    // Not breaches: watching, an animal's own feeding, a pet, a secret that is a subject.
    expect(r10('Juno waved at the whale shark from the raft.')).toBe(0)
    expect(r10('Sharks feed on fish and seals.')).toBe(0)
    expect(r10('Milo patted his dog and touched the LEGO brick.')).toBe(0)
    expect(r10('The secret of the pyramids stayed hidden for years.')).toBe(0)
    expect(r10('They told Mom everything at breakfast.')).toBe(0)
    // From /code-review: toys, pets, a person called Pat, a boat's back.
    expect(r10('Mia hugged her teddy bear and fell asleep.')).toBe(0)
    expect(r10('She cuddled her toy whale.')).toBe(0)
    expect(r10('Leo fed his pet turtle.')).toBe(0)
    expect(r10('Pat smiled at the dolphins.')).toBe(0)
    expect(r10('They watched the whale. Then Mia touched the back of the boat.')).toBe(0)
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
