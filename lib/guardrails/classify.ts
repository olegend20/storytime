import { callModel, parseJsonLoose, type GenerationLogSink } from '@/lib/ai/callModel'
import { InputClassification } from '@/lib/schemas/guardrail'
import { dataBlock, DATA_BLOCK_NOTICE } from './prompt'
import { INPUT_CLASSIFIER_PROMPT, promptSection, promptVersion } from './prompts'
import { namedInTopic } from './names'

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
   * refusal whose only fault was its minimum age is kept (see `salvageRefusal`) and is not
   * degraded.
   */
  degraded: boolean
  /**
   * True when the reply broke the contract but was kept by `salvageRefusal`. It is logged
   * (one `console.warn` line from `classifyInput`) and carried on `GuardInputResult` as
   * `internalReason: 'l2_refusal_age_filled'`; it is NOT stored on the `guardrail_events`
   * row, which has no column for a reason.
   */
  salvaged: boolean
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
    requested_characters: [],
    topic_key_hint: null,
    parent_message: null,
  }
}

/**
 * Only a character the parent typed into the topic counts (s3.3), and code decides that, not
 * the model: a name from the child's likes, or one the classifier made up, is dropped so
 * nothing downstream can grant rule 7's exception on the model's word alone. And when the
 * classifier thought it saw a character that is not there, its care notes - written to put
 * that character in the story - go with it: the writer would otherwise be told to include
 * someone rule 7 then forbids, and pay for a rewrite that contradicts itself.
 */
export function confirmCharacters(reply: InputClassification, topic: string): InputClassification {
  if (reply.decision === 'refuse') return { ...reply, requested_characters: [] }
  // Always the confirmed list: a name may come back shortened to what the parent typed
  // ("Sonic the Hedgehog" -> "Sonic"), not only dropped.
  const confirmed = namedInTopic(reply.requested_characters, topic)
  if (confirmed.length === 0) {
    const aboutCharacter = reply.category === 'commercial_ip_character' || reply.requested_characters.length > 0
    return { ...reply, requested_characters: [], care_notes: aboutCharacter ? null : reply.care_notes }
  }
  // A confirmed name means a character request, whatever the model labelled it: the
  // category the schema documents, and allow_with_care so the care notes reach the writer.
  return {
    ...reply,
    decision: 'allow_with_care',
    category: 'commercial_ip_character',
    requested_characters: confirmed,
  }
}

/**
 * The characters a parent asked for, as the rest of the pipeline may rely on them
 * (issue #27). A refusal never carries any: nothing is written, so nothing is borrowed.
 */
export function requestedCharacters(classification: InputClassification): string[] {
  return classification.decision === 'refuse' ? [] : classification.requested_characters
}

/**
 * Whether the reader must show the borrowed-character notice: exactly when the writer is
 * given a character, which is exactly when a confirmed name is on the list. A category with
 * no surviving name means no character reaches the story, so no notice.
 */
export function borrowsCharacter(classification: InputClassification): boolean {
  return requestedCharacters(classification).length > 0
}

/**
 * Keep a refusal whose only fault is its minimum age (issue #24).
 *
 * When the classifier declines a topic outright it has no age to recommend, and it says so:
 * `"min_recommended_age": null` (or 0, or 21, or "N/A"). The contract wants an integer from
 * 1 to 18, so the reply used to fail validation and the fail-closed default replaced it -
 * still a refusal, but with its reason thrown away: every specific refusal reached the
 * parent as the vaguest message we have, and was logged as `other`.
 *
 * For a refusal the age carries no meaning, so this overwrites an unusable one and
 * re-validates. It only ever does so for `decision: "refuse"` with a refusal category: an
 * allow, a reply that contradicts itself (refuse + `educational`), or one that is wrong in
 * any other way is not rescued and still fails closed. Nothing refused becomes allowed.
 */
export function salvageRefusal(reply: unknown, youngestAge: number): InputClassification | null {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return null
  const candidate = reply as Record<string, unknown>
  if (candidate.decision !== 'refuse' || candidate.category === 'educational') return null
  const age = candidate.min_recommended_age
  const usable = typeof age === 'number' && Number.isInteger(age) && age >= 1 && age <= 18
  if (usable) return null // the age was not the problem: leave it to fail closed
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

  const salvaged = result.data === null ? salvageRefusal(parseJsonLoose(result.text), input.youngestAge) : null
  const answer = result.data ?? salvaged
  const degraded = answer === null
  // The trace for "the contract was patched, not met": in the server log, since the event
  // row cannot carry it. No input text, only the category the classifier chose.
  if (salvaged) console.warn(`[guardrails] L2 refusal kept with its age filled in (category: ${salvaged.category})`)
  const raw = answer ?? failClosed(input.youngestAge)
  const classification = applyAgeBand(confirmCharacters(raw, input.topic), input.youngestAge)

  return {
    classification,
    costUsd: result.costUsd,
    replayed: result.replayed,
    degraded,
    salvaged: salvaged !== null,
  }
}

export function classifierPromptVersion(): number {
  return promptVersion(INPUT_CLASSIFIER_PROMPT)
}
