import type Anthropic from '@anthropic-ai/sdk'
import {
  callModel,
  capabilities,
  modelForRole,
  parseJsonLoose,
  structuredOutputRejected,
  type GenerationLogSink,
} from '@/lib/ai'
import { loadPrompt } from '@/lib/prompts'
import { dataBlock } from '@/lib/datablock'
import type { FactPack, FactSource } from '@/lib/schemas'
import { FACT_PACK_OUTPUT_FORMAT, KNOWLEDGE_PACK_OUTPUT_FORMAT } from './pack-schema'

/**
 * The fact-pack builder (F5). This is the ONLY step in StoryTime permitted to use the web
 * search tool (§1 principle 2), and it runs once per topic for every family that will ever
 * ask about it.
 *
 * Knowledge first, research when needed (owner decision 2026-09-29, DECISIONS #139):
 *
 *   0. KNOWLEDGE - one call, no tools, writes the pack from what the model knows and says
 *      how well it knows the topic (factpack-knowledge.v1). `solid` coverage with enough
 *      facts is the pack: ~30 s, a few cents. A children's story does not need a URL behind
 *      every fact.
 *   1. RESEARCH - only when coverage is not solid: one call per angle of the topic, all in
 *      parallel, one web search each, low effort, terse JSON findings out
 *      (factpack-research.v1). DECISIONS #137.
 *   2. WRITE - one call with no tools that turns the findings into the pack, under the
 *      2,000-token budget, with the format enforced (factpack.v3).
 *
 * The single call it replaces ran its searches one after another in one conversation, so
 * every result set was re-read on every later turn and the model thought and narrated
 * between searches: the first real parent to type a new topic waited **9 minutes** (553 s,
 * 21,000 output tokens, 770,000 input tokens, $0.99). Parallel single-search calls read
 * each result set once, and low effort stops the narration.
 *
 * It runs on the `factpack` role rather than `helper` because Haiku 4.5 does not support
 * the web_search server tool (DECISIONS.md #5).
 */

/** The angles researched in parallel. Each is one search, so this is also the search count. */
export const RESEARCH_ANGLES: readonly string[] = [
  'origins and history: when it began, who started it, the key dates and turning points',
  'how it works or what it is: the mechanism, the parts, the science, in plain terms',
  'records, numbers and surprising details children love',
  'famous people and moments, and where the subject stands today',
]

/** Searches per build: one per angle. Kept as the name the estimator and tests use. */
export const FACT_PACK_MAX_SEARCHES = RESEARCH_ANGLES.length

/** Fewer angles than this coming back means a pack would rest on too little. */
export const MIN_ANGLES_FOR_A_PACK = 2

/**
 * Why `max_uses` is the ONLY lever here.
 *
 * MEASURED: one `history-of-lego` build consumed **506,414 input tokens** and cost **$1.19** -
 * 6.6x the estimate - because every web-search result set is billed as INPUT. At $2/MTok on
 * Sonnet 5 that input was $1.01 of it; output was $0.10 and the searches themselves ~$0.05.
 *
 * `max_content_tokens` would be the direct lever but it belongs to the **web_fetch** tool, not
 * web_search - passing it here returns `400 Extra inputs are not permitted`. web_search takes
 * only `max_uses`, `allowed_domains`/`blocked_domains` and `user_location`, so bounding the
 * search COUNT is the only way to bound the input, hence 8 -> 5.
 */

export class WebSearchUnsupportedError extends Error {
  constructor(readonly model: string) {
    super(
      `Model "${model}" is configured for the factpack role but config/models.json says it ` +
        `does not support web search. Fact packs cannot be built without it.`,
    )
    this.name = 'WebSearchUnsupportedError'
  }
}

/**
 * The search tool definition, taken from config/models.json rather than hard-coded: the
 * tool type is versioned and moves with the model generation (kickoff rule 2).
 */
export function webSearchTool(model: string): Anthropic.ToolUnion {
  const caps = capabilities(model)
  if (caps.supports_web_search !== true) throw new WebSearchUnsupportedError(model)
  const type = typeof caps.web_search_tool_type === 'string' ? caps.web_search_tool_type : null
  if (!type) throw new WebSearchUnsupportedError(model)
  return {
    type,
    name: 'web_search',
    // One search per research call: the calls are parallel, one angle each.
    max_uses: 1,
  } as unknown as Anthropic.ToolUnion
}

/**
 * With a server tool in play the response interleaves the model's own narration, search
 * results and the final answer. Joining every text block and hunting for braces can splice
 * narration into the JSON, so prefer the LAST text block and fall back to the whole text.
 */
export function extractFinalJson(raw: unknown, joinedText: string): unknown {
  const content = (raw as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .filter((t) => t.trim() !== '')
    for (let i = texts.length - 1; i >= 0; i -= 1) {
      const parsed = parseJsonLoose(texts[i]!)
      if (parsed && typeof parsed === 'object') return parsed
    }
  }
  return parseJsonLoose(joinedText)
}

/** Sources cited by the model, for the `fact_packs.sources` column. */
export function sourcesOf(candidate: unknown): FactSource[] {
  const raw = (candidate as { sources?: unknown } | null)?.sources
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is FactSource => {
    const o = s as Record<string, unknown>
    return typeof o?.id === 'string' && typeof o?.title === 'string' && typeof o?.url === 'string'
  })
}

export interface BuildFactPackOptions {
  sink?: GenerationLogSink
  factPackId?: string | null
  signal?: AbortSignal
  /** Overrides the role's model. Used by the bake-off, not by production. */
  model?: string
}

export interface BuildFactPackResult {
  /** Parsed but NOT yet validated: the review pass names what is wrong (F5). */
  candidate: unknown
  model: string
  webSearches: number
  costUsd: number
  /** How the pack was made. Absent from test doubles. */
  mode?: 'knowledge' | 'research'
  /** What the knowledge stage said about the topic, when it ran. */
  coverage?: Coverage
  /** Stage timings, for the latency work this design exists for. Absent from test doubles. */
  latencyMs?: { knowledge: number; research: number; write: number }
}

export type Coverage = 'solid' | 'partial' | 'unknown'

/** Below this many facts a "solid" knowledge pack is treated as partial, and researched. */
export const KNOWLEDGE_MIN_FACTS = 12

/** Pin the key and label: the pack is stored under our key, not the model's spelling of it. */
function pinTopic(candidate: unknown, topicKey: string, topicLabel: string): unknown {
  if (candidate && typeof candidate === 'object') {
    const obj = candidate as Record<string, unknown>
    obj.topic_key = topicKey
    if (typeof obj.topic_label !== 'string' || obj.topic_label.trim() === '') {
      obj.topic_label = topicLabel
    }
  }
  return candidate
}

/** Stage 0: the pack from the model's own knowledge, and its account of how well it knows. */
export async function writeFromKnowledge(
  topicKey: string,
  topicLabel: string,
  opts: BuildFactPackOptions & { model: string },
): Promise<{ candidate: unknown; coverage: Coverage; facts: number; costUsd: number }> {
  const prompt = loadPrompt('factpack-knowledge')
  const write = (structured: boolean) =>
    callModel({
      purpose: 'factpack',
      model: opts.model,
      system: [{ text: prompt.body }],
      messages: [
        {
          role: 'user',
          content: [
            dataBlock('topic', JSON.stringify({ topic_key: topicKey, topic_label: topicLabel })),
            `Write the Fact Pack JSON from what you know. Use topic_key "${topicKey}" and ` +
              `topic_label "${topicLabel}" unchanged, and say your coverage honestly.`,
          ].join('\n\n'),
        },
      ],
      maxTokens: 8_000,
      timeoutMs: 240_000,
      maxRetries: 1,
      thinking: 'adaptive',
      effort: 'medium',
      ...(structured ? { outputConfig: { format: KNOWLEDGE_PACK_OUTPUT_FORMAT } } : {}),
      factPackId: opts.factPackId ?? null,
      ...(opts.sink ? { sink: opts.sink } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  const result = await write(true).catch((err: unknown) => {
    if (!structuredOutputRejected(err)) throw err
    return write(false)
  })
  const raw = extractFinalJson(result.raw, result.text) as Record<string, unknown> | null
  const coverageRaw = raw?.coverage
  const coverage: Coverage =
    coverageRaw === 'solid' || coverageRaw === 'partial' ? coverageRaw : 'unknown'
  const facts = Array.isArray(raw?.facts) ? raw.facts.length : 0
  if (raw) delete raw.coverage
  return { candidate: pinTopic(raw, topicKey, topicLabel), coverage, facts, costUsd: result.costUsd }
}

export interface ResearchFinding {
  fact: string
  source_title: string
  source_url: string
}

export interface AngleFindings {
  angle: string
  findings: ResearchFinding[]
  care: string
}

function asFindings(angle: string, raw: unknown): AngleFindings | null {
  const obj = raw as { findings?: unknown; care?: unknown } | null
  if (!obj || !Array.isArray(obj.findings)) return null
  const findings = obj.findings.filter(
    (f): f is ResearchFinding =>
      typeof (f as ResearchFinding)?.fact === 'string' &&
      typeof (f as ResearchFinding)?.source_title === 'string' &&
      typeof (f as ResearchFinding)?.source_url === 'string' &&
      /^https?:\/\//.test((f as ResearchFinding).source_url),
  )
  if (findings.length === 0) return null
  return { angle, findings, care: typeof obj.care === 'string' ? obj.care : '' }
}

/** Stage 1: one search on one angle. Terse by construction: low effort, small output. */
export async function researchAngle(
  topicKey: string,
  topicLabel: string,
  angle: string,
  opts: BuildFactPackOptions & { model: string },
): Promise<{ result: AngleFindings | null; webSearches: number; costUsd: number }> {
  const prompt = loadPrompt('factpack-research')
  const result = await callModel({
    purpose: 'factpack',
    model: opts.model,
    system: [{ text: prompt.body }],
    tools: [webSearchTool(opts.model)],
    messages: [
      {
        role: 'user',
        content: [
          dataBlock('topic', JSON.stringify({ topic_key: topicKey, topic_label: topicLabel })),
          dataBlock('angle', angle),
          'Search once for this angle of the topic and return the findings JSON.',
        ].join('\n\n'),
      },
    ],
    maxTokens: 3_000,
    timeoutMs: 240_000,
    maxRetries: 1,
    thinking: 'adaptive',
    effort: 'low',
    factPackId: opts.factPackId ?? null,
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return {
    result: asFindings(angle, extractFinalJson(result.raw, result.text)),
    webSearches: result.usage.web_searches,
    costUsd: result.costUsd,
  }
}

export function findingsBlocks(angles: readonly AngleFindings[]): string {
  return angles
    .map((a) => dataBlock('findings', JSON.stringify({ angle: a.angle, findings: a.findings, care: a.care })))
    .join('\n\n')
}

export async function buildFactPack(
  topicKey: string,
  topicLabel: string,
  opts: BuildFactPackOptions = {},
): Promise<BuildFactPackResult> {
  const model = opts.model ?? modelForRole('factpack')
  const shared = { ...opts, model }

  // ---- stage 0: from knowledge ----
  const knowledgeStarted = Date.now()
  const known = await writeFromKnowledge(topicKey, topicLabel, shared)
  const knowledge = Date.now() - knowledgeStarted
  if (known.coverage === 'solid' && known.facts >= KNOWLEDGE_MIN_FACTS) {
    console.info(`[factpack] "${topicKey}": written from knowledge in ${Math.round(knowledge / 1000)}s`)
    return {
      candidate: known.candidate,
      model,
      webSearches: 0,
      costUsd: known.costUsd,
      mode: 'knowledge',
      coverage: known.coverage,
      latencyMs: { knowledge, research: 0, write: 0 },
    }
  }
  console.info(
    `[factpack] "${topicKey}": model coverage ${known.coverage} (${known.facts} facts) - researching`,
  )

  // ---- stage 1: research, in parallel ----
  const researchStarted = Date.now()
  const settled = await Promise.allSettled(
    RESEARCH_ANGLES.map((angle) => researchAngle(topicKey, topicLabel, angle, shared)),
  )
  const angles: AngleFindings[] = []
  let webSearches = 0
  let costUsd = known.costUsd
  const failures: string[] = []
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === 'rejected') {
      failures.push(`${RESEARCH_ANGLES[i]}: ${String(outcome.reason)}`)
      continue
    }
    webSearches += outcome.value.webSearches
    costUsd += outcome.value.costUsd
    if (outcome.value.result) angles.push(outcome.value.result)
    else failures.push(`${RESEARCH_ANGLES[i]}: no usable findings`)
  }
  const research = Date.now() - researchStarted
  if (angles.length < MIN_ANGLES_FOR_A_PACK) {
    throw new Error(
      `fact pack research for "${topicKey}" found too little: ${angles.length} of ` +
        `${RESEARCH_ANGLES.length} angles returned findings. ${failures.join(' | ')}`,
    )
  }

  // ---- stage 2: write the pack from the findings ----
  const writeStarted = Date.now()
  const prompt = loadPrompt('factpack')
  const write = (structured: boolean) =>
    callModel({
      purpose: 'factpack',
      model,
      system: [{ text: prompt.body }],
      messages: [
        {
          role: 'user',
          content: [
            dataBlock('topic', JSON.stringify({ topic_key: topicKey, topic_label: topicLabel })),
            findingsBlocks(angles),
            `Write the Fact Pack JSON from these findings. Use topic_key "${topicKey}" and ` +
              `topic_label "${topicLabel}" unchanged.`,
          ].join('\n\n'),
        },
      ],
      maxTokens: 8_000,
      timeoutMs: 280_000,
      maxRetries: 1,
      thinking: 'adaptive',
      effort: 'medium',
      ...(structured ? { outputConfig: { format: FACT_PACK_OUTPUT_FORMAT } } : {}),
      factPackId: opts.factPackId ?? null,
      ...(opts.sink ? { sink: opts.sink } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  const written = await write(true).catch((err: unknown) => {
    if (!structuredOutputRejected(err)) throw err
    return write(false)
  })
  costUsd += written.costUsd

  return {
    candidate: pinTopic(extractFinalJson(written.raw, written.text), topicKey, topicLabel),
    model: written.model,
    webSearches,
    costUsd,
    mode: 'research',
    coverage: known.coverage,
    latencyMs: { knowledge, research, write: Date.now() - writeStarted },
  }
}

/** Narrow a reviewed candidate to a FactPack once the review has accepted it. */
export function asFactPack(candidate: unknown): FactPack {
  return candidate as FactPack
}
