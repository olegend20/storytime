import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { callModel, parseJsonLoose, type GenerationLogSink } from '@/lib/ai'
import {
  JudgePairwise,
  JudgeScore,
  applyCaps,
  resolvePositionSwap,
  unswap,
  type Verdict,
} from '@/lib/schemas'
import { assertBlind } from './blind'
import { buildCapContext, type CapContextInput, type FactPackLike, type GateSummary } from './caps'
import { renderPairwiseUserMessage, renderScoreUserMessage } from './render'
import type { CapContext, JudgeContext, JudgeableStory } from './types'

/**
 * The Judge Agent - JUDGE_AGENT.md §3/§4.
 *
 * It is a measuring instrument, so it is built not to be able to flatter us:
 *   - the payload is asserted blind before every call (§2, blind.ts);
 *   - story and parent text go in delimited data blocks, never the instruction region;
 *   - the weighted overall is recomputed from the criterion scores and the model's own
 *     arithmetic is discarded (DECISIONS.md #11);
 *   - the automatic caps are applied here, not requested from the model (#12);
 *   - a response that will not parse is retried exactly once and then recorded as
 *     `judge_error`, so a broken judge shows up as a hole in the data rather than as a
 *     quietly dropped story.
 */

export const JUDGE_PROMPT_FILE = 'judge.v1.md'
const PROMPT_MARKER = '--- PROMPT ---'
/** Judge output is short; the headroom is for models whose thinking is always on. */
export const JUDGE_MAX_TOKENS = 16_000

export interface JudgePrompt {
  version: string
  text: string
  sha256: string
}

let cachedPrompt: JudgePrompt | null = null

/**
 * Loads `prompts/judge.v1.md`, keeping only what follows the PROMPT marker. The sha is
 * recorded in every results file: CLAUDE.md rule 5 requires a re-run when the prompt
 * changes, and a hash in the results is how a reviewer can tell that it did.
 */
export function loadJudgePrompt(file: string = JUDGE_PROMPT_FILE): JudgePrompt {
  if (cachedPrompt && cachedPrompt.version === file.replace(/\.md$/, '')) return cachedPrompt
  const path = join(process.cwd(), 'prompts', file)
  const raw = readFileSync(path, 'utf8')
  const at = raw.indexOf(PROMPT_MARKER)
  if (at === -1) {
    throw new Error(`${path} is missing the "${PROMPT_MARKER}" marker; nothing to send.`)
  }
  const text = raw.slice(at + PROMPT_MARKER.length).trim()
  cachedPrompt = {
    version: file.replace(/\.md$/, ''),
    text,
    sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
  }
  return cachedPrompt
}

/**
 * SCORE output, plus the two excerpt fields §6's report needs ("three verbatim excerpts
 * per contestant chosen by the judge as best moment and worst moment").
 *
 * `JudgeScore` in `lib/schemas/` is the contract and is untouched - this extends it. Both
 * excerpts default to empty so an older recorded fixture still parses.
 */
export const JudgeScoreWithExcerpts = JudgeScore.extend({
  best_moment: z.string().default(''),
  worst_moment: z.string().default(''),
})
export type JudgeScoreWithExcerpts = z.infer<typeof JudgeScoreWithExcerpts>

export interface ParseResult<T> {
  ok: boolean
  data: T | null
  reason: string | null
}

function parseWith<T>(schema: z.ZodType<T>, text: string): ParseResult<T> {
  const json = parseJsonLoose(text)
  if (json === undefined) {
    return { ok: false, data: null, reason: 'response contained no parseable JSON object' }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    return { ok: false, data: null, reason: `schema rejected the response - ${issues}` }
  }
  return { ok: true, data: parsed.data, reason: null }
}

/** §7 VT: the parser accepts both schemas and rejects a score of 6. */
export function parseJudgeScore(text: string): ParseResult<JudgeScoreWithExcerpts> {
  return parseWith(JudgeScoreWithExcerpts, text)
}
export function parseJudgePairwise(text: string): ParseResult<JudgePairwise> {
  return parseWith(JudgePairwise, text)
}

// ---------------------------------------------------------------------------
// Shared call machinery
// ---------------------------------------------------------------------------

export interface JudgeCallCommon {
  /** A role from config/models.json. Default: the primary judge. */
  role?: 'judge_primary' | 'judge_secondary'
  /** Explicit model id. Only the harness sets this; it never comes from a story. */
  model?: string
  sink?: GenerationLogSink
  storyId?: string | null
  familyId?: string | null
  signal?: AbortSignal
  promptFile?: string
}

interface AttemptOutcome<T> {
  data: T | null
  reason: string | null
  attempts: number
  costUsd: number
  latencyMs: number
  model: string
  replayed: boolean
}

const REPAIR_INSTRUCTION = [
  'Your previous response could not be used.',
  'Respond again with the JSON for the mode you were given, and nothing else:',
  'no prose, no explanation, no markdown fences. Every criterion score must be an',
  'integer from 1 to 5. Do not change your judgement of the story - only its format.',
].join(' ')

/**
 * One call, one retry, then give up. The retry is a real second request with a repair
 * turn appended, so it gets its own fixture key and its own generation_logs row.
 */
async function callJudge<T>(args: {
  purpose: 'judge_score' | 'judge_pairwise'
  systemText: string
  userText: string
  schema: (text: string) => ParseResult<T>
  common: JudgeCallCommon
  where: string
}): Promise<AttemptOutcome<T>> {
  const { purpose, systemText, userText, common } = args
  const system = [{ text: systemText, cache: true as const }]

  // §2 + §7: nothing identifying reaches the model. Checked on the assembled payload
  // every time, not only in tests.
  assertBlind(`${systemText}\n${userText}`, args.where)

  let messages: Anthropic.MessageParam[] = [{ role: 'user', content: userText }]
  let costUsd = 0
  let latencyMs = 0
  let model = ''
  let replayed = false
  let reason: string | null = null

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await callModel({
      purpose,
      role: common.role ?? 'judge_primary',
      ...(common.model ? { model: common.model } : {}),
      system,
      messages,
      maxTokens: JUDGE_MAX_TOKENS,
      thinking: 'adaptive',
      sink: common.sink,
      storyId: common.storyId ?? null,
      familyId: common.familyId ?? null,
      signal: common.signal,
    })
    costUsd += res.costUsd
    latencyMs += res.latencyMs
    model = res.model
    replayed = res.replayed

    const parsed = args.schema(res.text)
    if (parsed.ok) {
      return { data: parsed.data, reason: null, attempts: attempt, costUsd, latencyMs, model, replayed }
    }
    reason = parsed.reason
    if (attempt === 2) break

    messages = [
      { role: 'user', content: userText },
      { role: 'assistant', content: res.text.trim() === '' ? '(empty response)' : res.text },
      { role: 'user', content: `${REPAIR_INSTRUCTION}\n\nThe problem was: ${parsed.reason}` },
    ]
    // The assistant turn is the judge's own words, but scan it anyway: cheap, and it
    // keeps the invariant "no judge request is ever sent unchecked".
    assertBlind(`${systemText}\n${JSON.stringify(messages)}`, `${args.where} (repair attempt)`)
  }

  return { data: null, reason, attempts: 2, costUsd, latencyMs, model, replayed }
}

// ---------------------------------------------------------------------------
// SCORE mode
// ---------------------------------------------------------------------------

export interface ScoreStoryInput extends JudgeCallCommon {
  context: JudgeContext
  story: JudgeableStory
  /** F7's verdict, when there is one. Null means "the gate has not run on this story". */
  gate?: GateSummary | null
  /** The pack the writer had. Null means the sourcing check cannot be run - see caps.ts. */
  factPack?: FactPackLike | null
}

export interface ScoreOk {
  ok: true
  /** Exactly what the model said, before our caps and before the overall is recomputed. */
  raw: JudgeScoreWithExcerpts
  /** What counts: caps applied and overall recomputed by us. */
  final: JudgeScore
  best_moment: string
  worst_moment: string
  capContext: CapContext
  model: string
  attempts: number
  costUsd: number
  latencyMs: number
  replayed: boolean
}

export interface JudgeError {
  ok: false
  error: 'judge_error'
  reason: string
  model: string
  attempts: number
  costUsd: number
  latencyMs: number
}

export type ScoreStoryResult = ScoreOk | JudgeError

export async function scoreStory(input: ScoreStoryInput): Promise<ScoreStoryResult> {
  const prompt = loadJudgePrompt(input.promptFile ?? JUDGE_PROMPT_FILE)
  const userText = renderScoreUserMessage(input.context, input.story)

  const outcome = await callJudge({
    purpose: 'judge_score',
    systemText: prompt.text,
    userText,
    schema: parseJudgeScore,
    common: input,
    where: 'SCORE payload',
  })

  if (!outcome.data) {
    return {
      ok: false,
      error: 'judge_error',
      reason: outcome.reason ?? 'unknown parse failure',
      model: outcome.model,
      attempts: outcome.attempts,
      costUsd: outcome.costUsd,
      latencyMs: outcome.latencyMs,
    }
  }

  const raw = outcome.data
  const capInput: CapContextInput = {
    story: input.story,
    target: input.context.target_words,
    factPack: input.factPack ?? null,
    gate: input.gate ?? null,
    judge: { disqualified: raw.disqualified, caps_applied: raw.caps_applied },
  }
  const capContext = buildCapContext(capInput)

  // The excerpts are for the report, not for scoring, so they are carried alongside the
  // JudgeScore rather than inside it - `lib/schemas/` stays exactly as the lead wrote it.
  const { best_moment, worst_moment, ...scorePart } = raw
  const final = applyCaps(scorePart, {
    guardrailBreach: capContext.guardrailBreach,
    inventedFact: capContext.inventedFact,
    wordCountOutOfRange: capContext.wordCountOutOfRange,
  })

  return {
    ok: true,
    raw,
    final,
    best_moment,
    worst_moment,
    capContext,
    model: outcome.model,
    attempts: outcome.attempts,
    costUsd: outcome.costUsd,
    latencyMs: outcome.latencyMs,
    replayed: outcome.replayed,
  }
}

// ---------------------------------------------------------------------------
// PAIRWISE mode
// ---------------------------------------------------------------------------

export interface ComparePairInput extends JudgeCallCommon {
  context: JudgeContext
  a: JudgeableStory
  b: JudgeableStory
}

export type ComparePairResult =
  | { ok: true; data: JudgePairwise; model: string; attempts: number; costUsd: number; latencyMs: number }
  | JudgeError

export async function comparePair(input: ComparePairInput): Promise<ComparePairResult> {
  const prompt = loadJudgePrompt(input.promptFile ?? JUDGE_PROMPT_FILE)
  const userText = renderPairwiseUserMessage(input.context, input.a, input.b)

  const outcome = await callJudge({
    purpose: 'judge_pairwise',
    systemText: prompt.text,
    userText,
    schema: parseJudgePairwise,
    common: input,
    where: 'PAIRWISE payload',
  })

  if (!outcome.data) {
    return {
      ok: false,
      error: 'judge_error',
      reason: outcome.reason ?? 'unknown parse failure',
      model: outcome.model,
      attempts: outcome.attempts,
      costUsd: outcome.costUsd,
      latencyMs: outcome.latencyMs,
    }
  }
  return {
    ok: true,
    data: outcome.data,
    model: outcome.model,
    attempts: outcome.attempts,
    costUsd: outcome.costUsd,
    latencyMs: outcome.latencyMs,
  }
}

export interface SwappedComparison {
  /** Resolved verdict in "challenger vs baseline" terms: A = challenger. */
  verdict: Verdict
  /** True when the two orders disagreed, which resolves to TIE (§2). */
  flipped: boolean
  /** Mean of the two stated confidences; the spread is the honest uncertainty. */
  confidence: number
  firstOrder: JudgePairwise | null
  secondOrder: JudgePairwise | null
  /** The second order's verdict already translated into first-order terms. */
  secondOrderAsFirstTerms: Verdict | null
  errors: string[]
  model: string
  costUsd: number
  latencyMs: number
}

/**
 * §2: every pairwise comparison runs twice with A/B swapped; a verdict that flips is
 * recorded as a tie. `challenger` is presented as A in the first order and as B in the
 * second, so the returned verdict is always in challenger-vs-baseline terms.
 *
 * A judge_error in either order collapses the comparison to TIE rather than letting a
 * single successful order stand: one order alone is exactly the position bias this
 * protocol exists to remove.
 */
export async function pairwiseWithSwap(input: {
  context: JudgeContext
  challenger: JudgeableStory
  baseline: JudgeableStory
  common?: JudgeCallCommon
}): Promise<SwappedComparison> {
  const common = input.common ?? {}
  const first = await comparePair({ ...common, context: input.context, a: input.challenger, b: input.baseline })
  const second = await comparePair({ ...common, context: input.context, a: input.baseline, b: input.challenger })

  const errors: string[] = []
  if (!first.ok) errors.push(`first order: ${first.reason}`)
  if (!second.ok) errors.push(`swapped order: ${second.reason}`)

  const costUsd = first.costUsd + second.costUsd
  const latencyMs = first.latencyMs + second.latencyMs
  const model = first.model || second.model

  if (!first.ok || !second.ok) {
    return {
      verdict: 'TIE',
      flipped: false,
      confidence: 0.5,
      firstOrder: first.ok ? first.data : null,
      secondOrder: second.ok ? second.data : null,
      secondOrderAsFirstTerms: second.ok ? unswap(second.data.verdict) : null,
      errors,
      model,
      costUsd,
      latencyMs,
    }
  }

  const secondAsFirst = unswap(second.data.verdict)
  const resolved = resolvePositionSwap(first.data.verdict, secondAsFirst)
  return {
    verdict: resolved.verdict,
    flipped: resolved.flipped,
    confidence: Math.round(((first.data.confidence + second.data.confidence) / 2) * 100) / 100,
    firstOrder: first.data,
    secondOrder: second.data,
    secondOrderAsFirstTerms: secondAsFirst,
    errors,
    model,
    costUsd,
    latencyMs,
  }
}
