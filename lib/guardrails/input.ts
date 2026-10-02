import type { GenerationLogSink } from '@/lib/ai/callModel'
import type {
  GuardrailCategory,
  GuardrailDecision,
  GuardrailLayer,
  InputClassification,
} from '@/lib/schemas/guardrail'
import { checkPayload, type L1Payload } from './l1'
import { classifyInput } from './classify'
import { logGuardrailEvent } from './events'
import { parentMessageFor, refusalMessage } from './messages'
import type { GuardedField } from './sanitize'

/**
 * The input guard a route calls: L1 then L2, in that order, with `guardrail_events`
 * logging on every refusal.
 *
 * F15 AC: "Refusals cost no quota and no writing-model call." Nothing here touches
 * `daily_usage`, and the only model call is the Haiku classifier - which is skipped
 * entirely when L1 has already refused (s1.2).
 */

export interface GuardInputRequest extends L1Payload {
  /** s1.6: the youngest selected child drives every age decision. */
  youngestAge: number
  youngestName?: string | null
  familyId?: string | null
  sink?: GenerationLogSink
  signal?: AbortSignal
  /** Skip L2 (used by the L1-only corpus measurement and by unit tests). */
  skipClassifier?: boolean
}

export interface GuardInputResult {
  decision: GuardrailDecision
  category: GuardrailCategory
  /** Which layer decided. Never surfaced to the parent (s5). */
  layer: GuardrailLayer | null
  /** Parent-facing copy for a refusal, from config/guardrails/messages.json. */
  parentMessage: string | null
  /** For `allow_with_care`, the writer's handling notes (s3.3). */
  careNotes: string | null
  topicKeyHint: string | null
  /** Internal diagnostics. Logged, never shown. */
  internalReason: string | null
  field: GuardedField | null
  sanitized: ReturnType<typeof checkPayload>['sanitized']
  classification: InputClassification | null
  costUsd: number
  /** Always 0 for an L1 refusal - the point of the layering. */
  modelCalls: number
}

export async function guardInput(request: GuardInputRequest): Promise<GuardInputResult> {
  const l1 = checkPayload(request)
  const base = {
    sanitized: l1.sanitized,
    classification: null,
    costUsd: 0,
    modelCalls: 0,
  }

  if (!l1.ok && l1.failure) {
    const f = l1.failure
    const field = (f.field ?? null) as GuardedField | null
    const category = f.category ?? 'other'
    await logGuardrailEvent({
      layer: 'L1',
      category,
      text: f.sanitized ?? '',
      field,
      familyId: request.familyId ?? null,
    })
    return {
      ...base,
      decision: 'refuse',
      category,
      layer: 'L1',
      parentMessage: refusalMessage({
        category,
        field,
        internalReason: f.internal_reason,
        youngestAge: request.youngestAge,
        youngestName: request.youngestName ?? null,
      }),
      careNotes: null,
      topicKeyHint: null,
      internalReason: f.internal_reason,
      field,
    }
  }

  if (request.skipClassifier === true) {
    return {
      ...base,
      decision: 'allow',
      category: 'educational',
      layer: null,
      parentMessage: null,
      careNotes: null,
      topicKeyHint: null,
      internalReason: null,
      field: null,
    }
  }

  const topic = l1.sanitized.topic_input ?? ''
  const { classification, costUsd, degraded, salvaged } = await classifyInput({
    topic,
    likes: l1.sanitized.likes,
    notes: l1.sanitized.notes,
    youngestAge: request.youngestAge,
    familyId: request.familyId ?? null,
    ...(request.sink ? { sink: request.sink } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  })

  const result: GuardInputResult = {
    ...base,
    decision: classification.decision,
    category: classification.category,
    layer: classification.decision === 'refuse' ? 'L2' : null,
    parentMessage: null,
    careNotes: classification.care_notes,
    topicKeyHint: classification.topic_key_hint,
    internalReason: degraded ? 'l2_unparseable_fail_closed' : salvaged ? 'l2_refusal_age_filled' : null,
    field: null,
    classification,
    costUsd,
    modelCalls: 1,
  }

  if (classification.decision === 'refuse') {
    await logGuardrailEvent({
      layer: 'L2',
      category: classification.category,
      text: topic,
      field: 'topic_input',
      familyId: request.familyId ?? null,
    })
    result.parentMessage = parentMessageFor(classification, {
      rawInput: topic,
      youngestAge: request.youngestAge,
      youngestName: request.youngestName ?? null,
    })
  }

  return result
}
