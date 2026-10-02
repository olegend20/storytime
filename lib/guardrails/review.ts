import { callModel, type GenerationLogSink } from '@/lib/ai/callModel'
import { OutputSafetyReview, type OutputViolation } from '@/lib/schemas/guardrail'
import type { AgeBand } from '@/lib/schemas/common'
import { dataBlock, DATA_BLOCK_NOTICE } from './prompt'
import { OUTPUT_REVIEW_PROMPT, promptSection, promptVersion } from './prompts'

/**
 * L4, second half - the Haiku safety review. GUARDRAILS.md s4.3, part of the F7 gate.
 *
 * Fail closed (s1.3): if the review cannot be parsed, the story is not shown.
 */

export interface ReviewInput {
  /** Full story prose. Wrapped in a <story> data block, never in the instructions. */
  storyText: string
  band: AgeBand
  childNames: string[]
  /** Characters the parent asked for by name: rule 7's one exception (issue #27). */
  requestedCharacters?: readonly string[]
  /** Soft signals from the deterministic scan, passed as things to check. */
  hints?: OutputViolation[]
  familyId?: string | null
  storyId?: string | null
  sink?: GenerationLogSink
  signal?: AbortSignal
}

export interface ReviewResult {
  review: OutputSafetyReview
  costUsd: number
  replayed: boolean
  /** True when the model's JSON did not validate and the fail-closed default was used. */
  degraded: boolean
}

export function reviewSystemPrompt(): string {
  return `${promptSection(OUTPUT_REVIEW_PROMPT, 'System prompt')}\n\n## Output\n\n${promptSection(
    OUTPUT_REVIEW_PROMPT,
    'Output',
  )}\n\n${DATA_BLOCK_NOTICE}`
}

export function reviewUserMessage(input: ReviewInput): string {
  const hints =
    input.hints && input.hints.length > 0
      ? input.hints.map((h) => `rule ${h.rule}`).join(', ')
      : 'nothing'
  const requested = input.requestedCharacters ?? []
  return [
    `Age band: ${input.band} (children: ${input.childNames.join(', ') || 'none named'})`,
    `Parent asked for: ${requested.length > 0 ? requested.map((n) => JSON.stringify(n)).join(', ') : 'no character'}`,
    `Deterministic scanner already noticed (may be false positives, check them): ${hints}`,
    dataBlock('story', input.storyText),
  ].join('\n\n')
}

/** s1.3: "If the output check is uncertain, the story is not shown." */
function failClosed(): OutputSafetyReview {
  return {
    safe: false,
    violations: [],
    scary_level: 3,
    positive_portrayal: false,
    ending_safe: false,
  }
}

export async function reviewOutput(input: ReviewInput): Promise<ReviewResult> {
  const result = await callModel<OutputSafetyReview>({
    purpose: 'safety_review',
    role: 'helper',
    system: [{ text: reviewSystemPrompt(), cache: true }],
    messages: [{ role: 'user', content: reviewUserMessage(input) }],
    maxTokens: 1500,
    schema: OutputSafetyReview,
    familyId: input.familyId ?? null,
    storyId: input.storyId ?? null,
    ...(input.sink ? { sink: input.sink } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })

  const degraded = result.data === null
  const review = degraded ? failClosed() : (result.data as OutputSafetyReview)

  // A model that lists a hard violation but sets safe:true has contradicted itself.
  const hasHard = review.violations.some((v) => v.severity === 'hard')
  const coerced = hasHard && review.safe ? { ...review, safe: false } : review

  return { review: coerced, costUsd: result.costUsd, replayed: result.replayed, degraded }
}

export function reviewPromptVersion(): number {
  return promptVersion(OUTPUT_REVIEW_PROMPT)
}
