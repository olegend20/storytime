import { callModel, parseJsonLoose, type GenerationLogSink } from '@/lib/ai'
import { loadPrompt } from '@/lib/prompts'
import { untrustedBlock } from '@/lib/datablock'
import { TopicNormalization } from '@/lib/schemas'

/**
 * Topic normalization (F5 / §4.3). Maps free text a parent typed onto a stable
 * `topic_key`, so "how lego was invented", "History of Lego" and "lego bricks story" all
 * share one researched Fact Pack. Research cost then scales with the topic library rather
 * than with families.
 *
 * Cheap: one Haiku call, ~300 in / 50 out. It also carries the first "is this a topic we
 * write about at all" judgement, so an inappropriate topic is refused before any expensive
 * call (F5 AC). It is NOT the guardrail - lane 6's L1/L2 run before it.
 */

export class TopicNormalizationError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message)
    this.name = 'TopicNormalizationError'
  }
}

/** Force any model-supplied key into the kebab-case shape the schema requires. */
export function slugifyTopicKey(raw: string): string {
  const slug = raw
    .normalize('NFKD')
    // Drop the combining marks NFKD just split off, or "Pokémon" would key as
    // "poke-mon" and split one shared fact pack into two.
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80)
    .replace(/-+$/g, '')
  return slug
}

export interface NormalizeTopicOptions {
  sink?: GenerationLogSink
  familyId?: string | null
  signal?: AbortSignal
}

/**
 * The model's raw output, repaired into the schema where it is safe to do so (key casing,
 * stray punctuation) and rejected where it is not (a missing decision, an empty label).
 */
export function parseNormalization(text: string): TopicNormalization | null {
  const raw = parseJsonLoose(text)
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  const key = typeof obj.topic_key === 'string' ? slugifyTopicKey(obj.topic_key) : ''
  if (key === '') return null

  const label =
    typeof obj.topic_label === 'string' && obj.topic_label.trim() !== ''
      ? obj.topic_label.trim().slice(0, 120)
      : key.replace(/-/g, ' ')

  // A missing or non-boolean appropriateness verdict must never read as "allowed".
  const appropriate = obj.is_appropriate_for_children === true

  const parsed = TopicNormalization.safeParse({
    topic_key: key,
    topic_label: label,
    is_appropriate_for_children: appropriate,
    reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 300) : '',
  })
  return parsed.success ? parsed.data : null
}

export async function normalizeTopic(
  text: string,
  opts: NormalizeTopicOptions = {},
): Promise<TopicNormalization> {
  const input = text.trim()
  if (input.length < 2) {
    throw new TopicNormalizationError('Topic is too short to normalize', 'topic_too_short')
  }

  const prompt = loadPrompt('normalize')
  const result = await callModel({
    purpose: 'normalize',
    role: 'helper',
    system: [{ text: prompt.body }],
    messages: [
      {
        role: 'user',
        content: `${untrustedBlock('topic', input)}\n\nReturn the normalization JSON.`,
      },
    ],
    maxTokens: 400,
    familyId: opts.familyId ?? null,
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  const parsed = parseNormalization(result.text)
  if (!parsed) {
    throw new TopicNormalizationError(
      'Topic normalization returned an unusable result',
      'normalize_unparseable',
    )
  }
  return parsed
}
