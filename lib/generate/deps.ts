import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerationLogSink } from '@/lib/ai'
import type { SafetyReviewer } from '@/lib/quality/gate'
import type { BlocklistData } from '@/lib/quality/blocklist'
import { DAILY_STORY_LIMIT, type InputClassification } from '@/lib/schemas'
import type { ChildProfile } from '@/lib/bible/children'

/**
 * Seams for the two lanes that own the other halves of this pipeline.
 *
 * Lane 3 owns quotas, the budget cap and the log sink (F8). Lane 6 owns the L1/L2 input
 * guardrails and the L4 output safety review (F15). Lane 2 builds neither - it declares the
 * interface, calls it, and honours the answer. Until a real implementation is injected the
 * defaults here are deliberately transparent about doing nothing, so nobody mistakes a stub
 * for a working quota or a working guardrail.
 */

export interface QuotaState {
  used: number
  limit: number
  /** Local midnight in the family's timezone, ISO 8601. */
  resets_at: string
  allowed: boolean
  /** False when GENERATION_ENABLED is off or the daily budget cap is spent. */
  generation_enabled: boolean
  /** Which of the two switches is off, when `generation_enabled` is false. */
  disabled_reason?: 'service_paused' | 'budget_exceeded'
}

export interface QuotaService {
  /** Called before any expensive work. Must not consume anything. */
  check(familyId: string): Promise<QuotaState>
  /** Called ONLY after a story row is successfully inserted (F8 AC). */
  consume(familyId: string): Promise<QuotaState>
}

/** Lane 3 has not wired F8 yet: allow, and report the limit honestly as not-yet-counted. */
export class UnmeteredQuotaService implements QuotaService {
  readonly isStub = true
  async check(): Promise<QuotaState> {
    return this.state(0)
  }
  async consume(): Promise<QuotaState> {
    return this.state(1)
  }
  private state(used: number): QuotaState {
    const midnight = new Date()
    midnight.setUTCHours(24, 0, 0, 0)
    return {
      used,
      limit: DAILY_STORY_LIMIT,
      resets_at: midnight.toISOString(),
      allowed: true,
      generation_enabled: true,
    }
  }
}

export interface GuardInput {
  topicInput: string
  children: readonly ChildProfile[]
  youngestAge: number
}

export interface InputGuard {
  /** L1 + L2. Returns the classification; the pipeline maps `refuse` onto the SSE codes. */
  check(input: GuardInput): Promise<InputClassification>
}

/** Lane 6 has not wired L1/L2 yet. Allow, and say so rather than implying a check ran. */
export class PermissiveInputGuard implements InputGuard {
  readonly isStub = true
  async check(): Promise<InputClassification> {
    return {
      decision: 'allow',
      category: 'educational',
      care_notes: null,
      min_recommended_age: 1,
      topic_key_hint: null,
      parent_message: null,
    }
  }
}

export interface GenerationDeps {
  db?: SupabaseClient
  sink?: GenerationLogSink
  quota?: QuotaService
  inputGuard?: InputGuard
  /** Lane 6's L4 output safety review, plugged into the F7 gate. */
  safetyReviewer?: SafetyReviewer
  /** Lane 6's input blocklist, scanned over the finished story alongside the output list. */
  extraBlocklists?: readonly BlocklistData[]
  now?: () => Date
}

export function resolveQuota(deps: GenerationDeps): QuotaService {
  return deps.quota ?? new UnmeteredQuotaService()
}

export function resolveGuard(deps: GenerationDeps): InputGuard {
  return deps.inputGuard ?? new PermissiveInputGuard()
}
