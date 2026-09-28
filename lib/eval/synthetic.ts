import { computeCost, modelForRole } from '@/lib/ai'
import { STORY_MIN_CHAPTERS, targetWords } from '@/lib/schemas'
import { narrativeWordCount } from './render'
import { loadReferenceCases, type ReferenceCase } from './references'
import { scenarioBand, type EvalScenario } from './scenarios'
import type { GenerateInput, PipelineStoryResult, StoryProvider } from './pipeline'
import type { JudgeableStory } from './types'

/**
 * SCAFFOLDING, NOT A CONTESTANT.
 *
 * A deterministic story pipeline that makes no model calls. It exists so the harness -
 * judge, caps, calibration checker, position swap, report generator, cost reconciliation -
 * can be built and tested end to end while F6 is still in flight, and so the §7 VT
 * "the bake-off harness runs on a 1-scenario × 2-contestant × 1-sample config in fixture
 * mode and produces the markdown report with all sections present" is a real test rather
 * than a promise.
 *
 * Its stories are derived from the reference stories, so they are in the right shape and
 * the right register. THEY ARE NOT MODEL OUTPUT and any score they receive is meaningless
 * as a quality measurement. Every artifact produced from this pipeline is stamped
 * `pipeline: "fixture"` and `synthetic: true` for exactly that reason.
 *
 * It writes its own `generation_logs` rows, the way the real pipeline does, so the
 * report's cost reconciliation section has something to reconcile against.
 */

/** FNV-1a, so a model id maps to a stable variant without pulling in a dependency. */
function hash32(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

let referenceCache: ReferenceCase[] | null = null
function references(): ReferenceCase[] {
  referenceCache ??= loadReferenceCases()
  return referenceCache
}

/** The reference whose length sits closest to this scenario's target midpoint. */
function pickSource(scenario: EvalScenario): ReferenceCase {
  const band = scenarioBand(scenario)
  const target = targetWords({ band, minutes: scenario.length_minutes })
  const mid = (target.min + target.max) / 2
  const cases = references()
  const sameBand = cases.filter((c) => c.entry.request.age_band === band)
  const pool = sameBand.length > 0 ? sameBand : cases
  return [...pool].sort(
    (a, b) => Math.abs(a.wordCount - mid) - Math.abs(b.wordCount - mid),
  )[0]!
}

/**
 * Simultaneous rename via sentinels. A naive sequential pass collapses a swap: renaming
 * Cruz→Phoenix and then Phoenix→Cruz would turn both children into Cruz, which is exactly
 * the mixed-ages scenario.
 */
function renameChildren(story: JudgeableStory, from: string[], to: string[]): JudgeableStory {
  let text = JSON.stringify(story)
  from.forEach((name, i) => {
    text = text.split(name).join(`@@${i}@@`)
  })
  from.forEach((name, i) => {
    text = text.split(`@@${i}@@`).join(to[i % to.length] ?? name)
  })
  return JSON.parse(text) as JudgeableStory
}

const VARIANT_SENTENCES = [
  'Somewhere behind them, the whole room seemed to lean in and listen.',
  'It was the kind of moment you would tell somebody about at breakfast.',
  'For a second, nobody said anything at all, and that was the best part.',
]

/**
 * Trim or top up so the story lands inside its band's word range - WITHOUT leaving the
 * 6-10 chapter range §4.1.2 requires.
 *
 * The guard used to be `chapters.length > 4`, which let a short target trim down to 4
 * chapters: `bees-band-a-5min` (650-850 words) came out with 4. Nothing failed, because
 * no test validated a synthetic story against `StoryOutput` - but a fixture generator that
 * cannot produce a schema-valid story is a trap for whoever adds that assertion next.
 * Dropping chapters now stops at STORY_MIN_CHAPTERS, and the remaining excess comes out of
 * chapter text instead.
 */
function fitToRange(story: JudgeableStory, target: { min: number; max: number }): JudgeableStory {
  let chapters = story.chapters.map((c) => ({ ...c }))
  // Too long: drop body chapters from the end, never the first or the last, and never
  // below the minimum chapter count.
  while (
    narrativeWordCount({ ...story, chapters }) > target.max &&
    chapters.length > STORY_MIN_CHAPTERS
  ) {
    chapters.splice(chapters.length - 2, 1)
  }
  // Still too long at the minimum chapter count: shorten body chapters sentence by
  // sentence rather than dropping a stop the schema requires.
  let shrinkGuard = 0
  while (narrativeWordCount({ ...story, chapters }) > target.max && shrinkGuard < 600) {
    const at = 1 + (shrinkGuard % Math.max(1, chapters.length - 2))
    const chapter = chapters[at]
    if (!chapter) break
    const sentences = chapter.text.split(/(?<=[.!?])\s+/)
    if (sentences.length <= 2) {
      shrinkGuard += 1
      continue
    }
    chapters = chapters.map((c, i) =>
      i === at ? { ...c, text: sentences.slice(0, -1).join(' ') } : c,
    )
    shrinkGuard += 1
  }
  // Too short: lengthen body chapters with a repeated beat rather than adding stops.
  let guard = 0
  while (narrativeWordCount({ ...story, chapters }) < target.min && guard < 400) {
    const at = 1 + (guard % Math.max(1, chapters.length - 2))
    const chapter = chapters[at] ?? chapters[0]!
    chapters = chapters.map((c, i) =>
      i === at
        ? { ...c, text: `${chapter.text}\n\n${VARIANT_SENTENCES[guard % VARIANT_SENTENCES.length]!}` }
        : c,
    )
    guard += 1
  }
  return { ...story, chapters }
}

/** The synthetic story for one scenario × contestant × sample. Deterministic. */
export function syntheticStory(input: {
  scenario: EvalScenario
  writingModel: string
  sample: number
}): JudgeableStory {
  const source = pickSource(input.scenario)
  const band = scenarioBand(input.scenario)
  const target = targetWords({ band, minutes: input.scenario.length_minutes })
  const seed = hash32(`${input.writingModel}|${input.sample}`)

  const renamed = renameChildren(
    source.story,
    source.entry.request.children.map((c) => c.name),
    input.scenario.children.map((c) => c.name),
  )

  // A contestant-specific beat in a seeded subset of chapters, so two contestants never
  // produce a byte-identical story (which would make a pairwise comparison vacuous).
  const marked: JudgeableStory = {
    ...renamed,
    title: renamed.title,
    chapters: renamed.chapters.map((c, i) =>
      (seed + i) % 3 === 0
        ? { ...c, text: `${c.text}\n\n${VARIANT_SENTENCES[(seed + i) % VARIANT_SENTENCES.length]!}` }
        : { ...c },
    ),
  }

  return fitToRange(marked, target)
}

/**
 * Plausible token usage, scaled off the story's own length so a longer story costs more.
 * Not a prediction of real usage - just arithmetic that behaves like it.
 */
function syntheticUsage(story: JudgeableStory): {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
} {
  const words = narrativeWordCount(story)
  const output = Math.round(words * 1.4) + 600
  return { input: 1_500, cacheRead: 4_000, cacheWrite: 0, output }
}

/**
 * Builds the provider. `sink` receives one row per pipeline step, as the real pipeline
 * would write: normalize and quality on the helper model, the story on the contestant.
 */
export function syntheticProvider(): StoryProvider {
  return async (input: GenerateInput): Promise<PipelineStoryResult> => {
    const story = syntheticStory(input)
    const usage = syntheticUsage(story)
    const helper = modelForRole('helper')

    const writeCost = computeCost({
      model: input.writingModel,
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
    })
    const normalizeCost = computeCost({ model: helper, input: 300, output: 50 })
    const qualityCost = computeCost({ model: helper, input: 6_000, output: 200 })

    // Deterministic, model-dependent latencies so the p50/p95 section is not degenerate.
    const seed = hash32(`${input.writingModel}|${input.scenario.id}|${input.sample}`)
    const totalMs = 12_000 + (seed % 9_000)
    const toFirstChapterMs = Math.round(totalMs * 0.35)

    if (input.sink) {
      await input.sink.write({
        family_id: null,
        story_id: input.storyId,
        fact_pack_id: null,
        purpose: 'normalize',
        model: helper,
        input_tokens: 300,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 50,
        cost_usd: normalizeCost,
        latency_ms: 400,
        ok: true,
        error: null,
      })
      await input.sink.write({
        family_id: null,
        story_id: input.storyId,
        fact_pack_id: null,
        purpose: 'write',
        model: input.writingModel,
        input_tokens: usage.input,
        cache_read_tokens: usage.cacheRead,
        cache_write_tokens: usage.cacheWrite,
        output_tokens: usage.output,
        cost_usd: writeCost,
        latency_ms: totalMs,
        ok: true,
        error: null,
      })
      await input.sink.write({
        family_id: null,
        story_id: input.storyId,
        fact_pack_id: null,
        purpose: 'quality',
        model: helper,
        input_tokens: 6_000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 200,
        cost_usd: qualityCost,
        latency_ms: 900,
        ok: true,
        error: null,
      })
    }

    return {
      story,
      // No fact pack: caps.ts then records the sourcing check as unverifiable rather than
      // silently passing it, which is the honest state for a story nobody researched.
      factPack: null,
      gate: { outcome: 'pass', hard_violations: [], failures: [] },
      writingModel: input.writingModel,
      costUsd: Math.round((writeCost + normalizeCost + qualityCost) * 1e6) / 1e6,
      latency: { toFirstChapterMs, totalMs },
      attempts: 1,
    }
  }
}

