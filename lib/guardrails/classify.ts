import { callModel, parseJsonLoose, type GenerationLogSink } from '@/lib/ai/callModel'
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
  /**
   * True when the model's JSON did not validate and the fail-closed default was used. A
   * refusal that only lacked a minimum age is kept (see `salvageRefusal`) and is not degraded.
   */
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
 * Keep a refusal whose only fault is a missing minimum age (issue #24).
 *
 * When the classifier declines a topic outright it has no age to recommend, and it says so:
 * `"min_recommended_age": null`. The contract wants an integer, so the reply used to fail
 * validation and the fail-closed default replaced it - still a refusal, but with its reason
 * and its wording thrown away: every specific refusal reached the parent as the vaguest
 * message we have, and was logged as `other`.
 *
 * This fills in the age and re-validates. It only ever does so for `decision: "refuse"`:
 * an allow with no age, or a reply that is wrong in any other way, is not rescued and still
 * fails closed. Nothing that was refused becomes allowed.
 */
export function salvageRefusal(reply: unknown, youngestAge: number): InputClassification | null {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return null
  const candidate = reply as Record<string, unknown>
  if (candidate.decision !== 'refuse') return null
  if (candidate.min_recommended_age !== null && candidate.min_recommended_age !== undefined) return null
  const parsed = InputClassification.safeParse({
    ...candidate,
    min_recommended_age: Math.max(youngestAge, 1),
  })
  // The schema still has to accept everything else, and the decision is checked again on the
  // parsed value rather than trusted from the raw one.
  return parsed.success && parsed.data.decision === 'refuse' ? parsed.data : null
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
 * `output_config.format` (DECISIONS.md #69): structured outputs are documented as
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

  const answer = result.data ?? salvageRefusal(parseJsonLoose(result.text), input.youngestAge)
  const degraded = answer === null
  const classification = applyAgeBand(answer ?? failClosed(input.youngestAge), input.youngestAge)

  return { classification, costUsd: result.costUsd, replayed: result.replayed, degraded }
}

export function classifierPromptVersion(): number {
  return promptVersion(INPUT_CLASSIFIER_PROMPT)
}
