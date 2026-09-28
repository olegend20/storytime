import type Anthropic from '@anthropic-ai/sdk'
import { callModel, capabilities, modelForRole, parseJsonLoose, type GenerationLogSink } from '@/lib/ai'
import { loadPrompt } from '@/lib/prompts'
import { dataBlock } from '@/lib/datablock'
import type { FactPack, FactSource } from '@/lib/schemas'

/**
 * The fact-pack builder (F5). This is the ONLY step in StoryTime permitted to use the web
 * search tool (§1 principle 2), and it runs once per topic for every family that will ever
 * ask about it.
 *
 * It runs on the `factpack` role rather than `helper` because Haiku 4.5 does not support
 * the web_search server tool (DECISIONS.md #5).
 */

export const FACT_PACK_MAX_SEARCHES = 5

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
    max_uses: FACT_PACK_MAX_SEARCHES,
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
}

export async function buildFactPack(
  topicKey: string,
  topicLabel: string,
  opts: BuildFactPackOptions = {},
): Promise<BuildFactPackResult> {
  const model = opts.model ?? modelForRole('factpack')
  const prompt = loadPrompt('factpack')

  const result = await callModel({
    purpose: 'factpack',
    model,
    system: [{ text: prompt.body }],
    tools: [webSearchTool(model)],
    messages: [
      {
        role: 'user',
        content: [
          dataBlock('topic', JSON.stringify({ topic_key: topicKey, topic_label: topicLabel })),
          `Research this topic and return the Fact Pack JSON. Use topic_key "${topicKey}" and ` +
            `topic_label "${topicLabel}" unchanged.`,
        ].join('\n\n'),
      },
    ],
    /**
     * Back to 16k. Dropping this to 6k to save time produced `unparseable`: with a server
     * tool the response interleaves narration, search results and the final answer across
     * several turns, and 6k truncated the JSON mid-object. The pack itself must fit 2,000
     * tokens (§4.3), but the *response* needs room for the reasoning around it. Cost is
     * controlled on the input side instead - see FACT_PACK_MAX_SEARCH_CONTENT_TOKENS - since
     * input was 98% of the measured token volume.
     */
    maxTokens: 16_000,
    /**
     * The web-search tool loop makes this the longest call in the system. Three retries of a
     * timing-out 5-minute request cost 902s and produced nothing, so: a generous single
     * timeout, and one retry rather than three.
     */
    timeoutMs: 600_000,
    maxRetries: 1,
    thinking: 'adaptive',
    factPackId: opts.factPackId ?? null,
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  const candidate = extractFinalJson(result.raw, result.text)
  // Pin the key and label: the pack is stored under our key, not the model's spelling of it.
  if (candidate && typeof candidate === 'object') {
    const obj = candidate as Record<string, unknown>
    obj.topic_key = topicKey
    if (typeof obj.topic_label !== 'string' || obj.topic_label.trim() === '') {
      obj.topic_label = topicLabel
    }
  }

  return {
    candidate,
    model: result.model,
    webSearches: result.usage.web_searches,
    costUsd: result.costUsd,
  }
}

/** Narrow a reviewed candidate to a FactPack once the review has accepted it. */
export function asFactPack(candidate: unknown): FactPack {
  return candidate as FactPack
}
