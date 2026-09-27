import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * GUARD: the four reference stories are load-bearing and were NOT in the handover archive.
 *
 * They are required by:
 *   - IMPLEMENTATION_PLAN.md s4.1.8 - style anchors in the master prompt
 *   - JUDGE_AGENT.md s5 - every row of the judge calibration set
 *   - F13 AC - "judge calibration set passes before results count"
 *   - F7 VT - the four stories pass the deterministic gate
 *   - F5 VT - live fact packs contain the anchor facts from their True Facts lists
 *
 * This test fails on purpose until the files arrive. Do NOT satisfy it with
 * model-written substitutes: calibrating the judge against stories we generated, then
 * using that judge to grade stories we generate, measures nothing.
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
