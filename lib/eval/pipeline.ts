import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GenerationLogSink } from '@/lib/ai'
import type { FactPackLike, GateSummary } from './caps'
import type { EvalScenario } from './scenarios'
import type { JudgeableStory } from './types'

/**
 * The seam between the eval harness and F6/F7 (lane 2, in flight).
 *
 * F13 is "generate stories for 8 scenarios through the real pipeline, run the quality
 * gate, score them". Lane 5 owns the scoring and the reporting; the generating belongs to
 * lane 2. Rather than block, the harness talks to this narrow interface and gets one of
 * two implementations:
 *
 *   - `live`    - lane 2's pipeline, loaded dynamically from `lib/generate` so this file
 *                 does not import a module that does not exist yet.
 *   - `fixture` - recorded or synthetic stories, for building and testing the harness.
 *
 * Nothing above this line knows which one it got, which is the point: when F6 lands,
 * `pnpm eval` starts making real stories with no change to the judge, the caps, the
 * calibration or the report.
 */

export interface PipelineLatency {
  /** Time to the first chapter being available (streaming). Null when not measurable. */
  toFirstChapterMs: number | null
  totalMs: number
}

export interface PipelineStoryResult {
  story: JudgeableStory
  /** The pack the writer had. Null means the sourcing check cannot run - see caps.ts. */
  factPack: FactPackLike | null
  /** F7's verdict. Null means the gate did not run on this story. */
  gate: GateSummary | null
  /** The model that actually wrote it, for the report (never for the judge). */
  writingModel: string
  /** Cost of the whole story: every call in the pipeline, not just the writing call. */
  costUsd: number
  latency: PipelineLatency
  /** Attempts including rewrites, so the gate's rewrite rate is reportable. */
  attempts: number
  /**
   * Did the writer's first draft go out untouched: no rewrite, no shorter retry, no mend,
   * no cut? The owner's hill-climb metric (2026-10-08): toward 0 rewrites because the
   * prompt gets it right up front. Null when the pipeline cannot tell (fixture stories).
   */
  firstDraft?: FirstDraft | null
}

export interface FirstDraft {
  passed: boolean
  /** The gate's checks that sent it back (`QualityFailure.check`), empty when it passed. */
  failures: string[]
  /** The rewrite reasons the writer was given, as the gate wrote them. */
  reasons: string[]
  /** Hard rules mended or cut in place (rungs 1-2). */
  mended_rules: number[]
}

export interface GenerateInput {
  scenario: EvalScenario
  /** The contestant. A config model id - F14 AC: "writing model is a config value". */
  writingModel: string
  /** 1-based sample index; §2 asks for 3 samples per scenario × model. */
  sample: number
  sink?: GenerationLogSink
  /** Correlates generation_logs rows with the run, for the cost reconciliation section. */
  storyId: string
  signal?: AbortSignal
}

export interface StoryPipeline {
  readonly kind: 'live' | 'fixture'
  readonly describe: string
  generate(input: GenerateInput): Promise<PipelineStoryResult>
}

export class PipelineUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `No live story pipeline available: ${detail}\n` +
        `F13 depends on F6 (story generation) and F7 (quality gate), which lane 2 owns.\n` +
        `Until they land, run the harness in fixture mode:\n` +
        `  EVAL_PIPELINE=fixture pnpm eval\n` +
        `Fixture mode exercises the judge, the caps, the calibration checker and the report,\n` +
        `but the stories are not generated, so its scores are NOT eval results.`,
    )
    this.name = 'PipelineUnavailableError'
  }
}

/**
 * The live adapter over lane 2's pipeline. Loaded dynamically so fixture mode never pulls in
 * Supabase or the SDK. It lives in lib/eval, not lib/generate: the request path must not
 * import the eval harness (test/unit/judge-not-in-runtime.test.ts).
 */
const LIVE_PIPELINE_MODULE = '@/lib/eval/live-pipeline'

interface LivePipelineModule {
  createEvalPipeline?: () => StoryPipeline
}

export async function loadLivePipeline(): Promise<StoryPipeline> {
  let mod: LivePipelineModule
  try {
    mod = (await import(/* webpackIgnore: true */ LIVE_PIPELINE_MODULE)) as LivePipelineModule
  } catch (err) {
    throw new PipelineUnavailableError(
      `cannot import ${LIVE_PIPELINE_MODULE} (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (typeof mod.createEvalPipeline !== 'function') {
    throw new PipelineUnavailableError(
      `${LIVE_PIPELINE_MODULE} does not export createEvalPipeline(). Lane 5 needs exactly one ` +
        `function returning { kind, describe, generate(input) } - see lib/eval/pipeline.ts.`,
    )
  }
  return mod.createEvalPipeline()
}

// ---------------------------------------------------------------------------
// Fixture pipeline
// ---------------------------------------------------------------------------

export const STORY_FIXTURE_DIR = join(process.cwd(), 'eval', 'fixtures', 'stories')

/** Supplies a story without generating one. Returning null falls through to disk. */
export type StoryProvider = (
  input: GenerateInput,
) => PipelineStoryResult | null | Promise<PipelineStoryResult | null>

export function storyFixturePath(input: GenerateInput, dir = STORY_FIXTURE_DIR): string {
  // The model id appears in the FILENAME only; filenames never enter a judge payload.
  return join(dir, `${input.scenario.id}.${input.writingModel}.${input.sample}.json`)
}

export function createFixturePipeline(opts: {
  provider?: StoryProvider
  dir?: string
  describe?: string
}): StoryPipeline {
  const dir = opts.dir ?? STORY_FIXTURE_DIR
  return {
    kind: 'fixture',
    describe: opts.describe ?? `fixture stories from ${dir}`,
    async generate(input: GenerateInput): Promise<PipelineStoryResult> {
      const provided = await opts.provider?.(input)
      if (provided) return provided
      const path = storyFixturePath(input, dir)
      if (!existsSync(path)) {
        throw new PipelineUnavailableError(
          `no fixture story at ${path} and no provider supplied one`,
        )
      }
      return JSON.parse(readFileSync(path, 'utf8')) as PipelineStoryResult
    },
  }
}

/** `EVAL_PIPELINE=fixture` forces fixture mode; anything else asks lane 2 for the real one. */
export function pipelineModeFromEnv(env: NodeJS.ProcessEnv = process.env): 'live' | 'fixture' {
  return env.EVAL_PIPELINE === 'fixture' ? 'fixture' : 'live'
}

export async function loadPipeline(opts: {
  mode?: 'live' | 'fixture'
  provider?: StoryProvider
  dir?: string
} = {}): Promise<StoryPipeline> {
  const mode = opts.mode ?? pipelineModeFromEnv()
  if (mode === 'fixture') {
    return createFixturePipeline({
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.dir ? { dir: opts.dir } : {}),
    })
  }
  return loadLivePipeline()
}
