import { callModel, type GenerationLogSink } from '@/lib/ai/callModel'
import { InputClassification } from '@/lib/schemas/guardrail'
import { dataBlock, DATA_BLOCK_NOTICE } from './prompt'
import { INPUT_CLASSIFIER_PROMPT, promptSection, promptVersion } from './prompts'

/**
 * L2 - the Haiku input classifier. GUARDRAILS.md s3.3.
 *
 * Runs only on input that already passed L1 (s1.2: cheap layers first), and never on a
 * request L1 refused - a refusal must cost as close to zero as possible.
 */

export interface ClassifyInput {
  /** Sanitized topic from L1. Never the raw string. */
  topic: string
  likes?: string[]
  notes?: string | null
  /** s1.6 / s3.3: the decision uses the YOUNGEST selected child. */
  youngestAge: number
  familyId?: string | null
  sink?: GenerationLogSink
  signal?: AbortSignal
}

export interface ClassifyResult {
  classification: InputClassification
  costUsd: number
  replayed: boolean
  /** True when the model's JSON did not validate and the fail-closed default was used. */
  degraded: boolean
}

export function classifierSystemPrompt(): string {
  return `${promptSection(INPUT_CLASSIFIER_PROMPT, 'System prompt')}\n\n## Output\n\n${promptSection(
    INPUT_CLASSIFIER_PROMPT,
    'Output',
  )}\n\n${DATA_BLOCK_NOTICE}`
}

export function classifierUserMessage(input: ClassifyInput): string {
  const likes = (input.likes ?? []).filter((l) => l.trim() !== '')
  return [
    `Youngest selected child's age: ${input.youngestAge}`,
    dataBlock('topic', input.topic),
    dataBlock('likes', likes.length > 0 ? likes.join(', ') : '(none given)'),
    dataBlock('notes', input.notes && input.notes.trim() !== '' ? input.notes : '(none given)'),
  ].join('\n\n')
}

/**
 * s1.3 "fail closed on output, fail kind on input" cuts both ways at L2: an
 * unparseable classifier response must not become a silent allow. We refuse, kindly.
 */
function failClosed(youngestAge: number): InputClassification {
  return {
    decision: 'refuse',
    category: 'other',
    care_notes: null,
    min_recommended_age: Math.max(youngestAge, 1),
    topic_key_hint: null,
    parent_message: null,
  }
}

/**
 * Deterministic age-band enforcement on top of the model's answer. s3.3 asks the
 * classifier to do this itself; doing it again in code makes the band behaviour a
 * property of the system rather than of one model call, which is what the corpus
 * asserts (the Titanic at 4 vs at 7).
 */
export function applyAgeBand(
  classification: InputClassification,
  youngestAge: number,
): InputClassification {
  if (
    classification.decision !== 'refuse' &&
    classification.min_recommended_age > youngestAge
  ) {
    return { ...classification, decision: 'refuse', category: 'too_mature_for_band' }
  }
  // A model that says too_mature_for_band but sets a min age at or below the youngest
  // child has contradicted itself; keep the refusal and make the number consistent.
  if (
    classification.category === 'too_mature_for_band' &&
    classification.min_recommended_age <= youngestAge
  ) {
    return { ...classification, decision: 'refuse', min_recommended_age: youngestAge + 1 }
  }
  return classification
}

/**
 * JSON is constrained by prompt instruction plus zod validation rather than
 * `output_config.format` (DECISIONS.md #35): structured outputs are documented as
 * available, but Haiku 4.5's support could not be verified live here, and a wrong shape
 * would 400 on the nightly run. To enable it once verified, add
 * `outputConfig: { format: zodOutputFormat(InputClassification) }` below and re-record the
 * fixtures - the fixture key includes output_config, so every fixture must be re-recorded.
 */
export async function classifyInput(input: ClassifyInput): Promise<ClassifyResult> {
  const result = await callModel<InputClassification>({
    purpose: 'classify_input',
    role: 'helper',
    system: [{ text: classifierSystemPrompt(), cache: true }],
    messages: [{ role: 'user', content: classifierUserMessage(input) }],
    maxTokens: 700,
    schema: InputClassification,
    familyId: input.familyId ?? null,
    ...(input.sink ? { sink: input.sink } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })

  const degraded = result.data === null
  const classification = applyAgeBand(
    degraded ? failClosed(input.youngestAge) : (result.data as InputClassification),
    input.youngestAge,
  )

  return { classification, costUsd: result.costUsd, replayed: result.replayed, degraded }
}

export function classifierPromptVersion(): number {
  return promptVersion(INPUT_CLASSIFIER_PROMPT)
}
