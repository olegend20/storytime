import { callModel, parseJsonLoose, type GenerationLogSink } from '@/lib/ai'
import { loadPrompt } from '@/lib/prompts'
import { dataBlock } from '@/lib/datablock'
import { StoryOutput } from '@/lib/schemas'
import { normalizeStoryCandidate } from './normalize'

/**
 * Story JSON parsing and repair (§4.4).
 *
 * Order matters for cost: fences, preambles and trailing commentary are stripped locally
 * and for free, and so are slips in the story's metadata (normalize.ts - an over-long
 * shout line, a third recurring element). Only a payload that is still invalid after that
 * gets the one Haiku repair attempt; if that also fails, it is a generation failure.
 */

export type ParseOutcome =
  | { ok: true; story: StoryOutput; repaired: boolean; /** Local fixes applied. */ notes: string[] }
  | { ok: false; reason: string; issues: string[] }

/** Free, local parse. Handles ```json fences and text around the object. */
export function parseStoryOutputLocal(text: string): ParseOutcome {
  const raw = parseJsonLoose(text)
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'not_json', issues: ['no JSON object found in the response'] }
  }
  const normalized = normalizeStoryCandidate(raw)
  const parsed = StoryOutput.safeParse(normalized.value)
  if (parsed.success) {
    return { ok: true, story: parsed.data, repaired: false, notes: normalized.notes }
  }
  return {
    ok: false,
    reason: 'schema_invalid',
    issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`),
  }
}

export interface RepairOptions {
  sink?: GenerationLogSink
  familyId?: string | null
  storyId?: string | null
  signal?: AbortSignal
}

/**
 * The one repair attempt. The prompt is a format converter, explicitly forbidden from
 * rewriting prose - a "repair" that quietly rewrote the story would make the quality gate
 * meaningless.
 */
export async function repairStoryOutput(
  text: string,
  issues: readonly string[],
  opts: RepairOptions = {},
): Promise<ParseOutcome> {
  const prompt = loadPrompt('repair')
  const result = await callModel({
    purpose: 'repair',
    role: 'helper',
    system: [{ text: prompt.body }],
    messages: [
      {
        role: 'user',
        content: [
          dataBlock('payload', text),
          issues.length > 0
            ? dataBlock('validation_errors', issues.map((i) => `- ${i}`).join('\n'))
            : '',
          'Return the corrected JSON object only.',
        ]
          .filter((part) => part !== '')
          .join('\n\n'),
      },
    ],
    maxTokens: 16_000,
    familyId: opts.familyId ?? null,
    storyId: opts.storyId ?? null,
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  const local = parseStoryOutputLocal(result.text)
  if (local.ok) return { ok: true, story: local.story, repaired: true, notes: local.notes }
  return { ok: false, reason: `repair_failed:${local.reason}`, issues: local.issues }
}

/** Local parse, then at most one model repair. */
export async function parseStoryOutput(
  text: string,
  opts: RepairOptions & { allowRepair?: boolean } = {},
): Promise<ParseOutcome> {
  const local = parseStoryOutputLocal(text)
  if (local.ok || opts.allowRepair === false) return local
  // Field paths and rule messages only, never story text: the writer needed repair on every
  // attempt of the owner's first real stories, and which rule it breaks is the whole question.
  console.warn(`[generate] story JSON needs repair (${local.reason}): ${local.issues.slice(0, 8).join(' | ')}`)
  return repairStoryOutput(text, local.issues, opts)
}
