import type { SupabaseClient } from '@supabase/supabase-js'
import type { GenerationLogSink } from '@/lib/ai'
import type { SafetyReviewer } from '@/lib/quality/gate'
import type { BlocklistData } from '@/lib/quality/blocklist'
import { DAILY_STORY_LIMIT, type InputClassification } from '@/lib/schemas'
import type { GetOrBuildOptions } from '@/lib/topics'
import type { ChildProfile } from '@/lib/bible/children'

/**
 * Seams for the two lanes that own the other halves of this pipeline.
 *
 * Lane 3 owns quotas, the budget cap and the log sink (F8/F12) in `lib/limits/` and
 * `lib/costs/`. Lane 6 owns the L1/L2 input guardrails and the L4 output safety review
 * (F15). Lane 2 builds neither - it declares the interface, calls it in the right order, and
 * honours the answer. Until a real implementation is injected the defaults here are
 * deliberately loud about doing nothing (`isStub`), so nobody mistakes a stub for a working
 * quota or a working guardrail.
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

/**
 * Lane 3's quota surface, named exactly as they named it so the merge is a wiring change
 * and not a translation layer.
 *
 * The split is the safety property: `preflight` and `quotaStatus` MUST NOT move the counter,
 * and `consumeQuota` is the only thing that does. F8's AC - "quota is consumed only on a
 * successful `stories` insert" - is enforced entirely by where lane 2 calls them, which is:
 *
 *   prepareGeneration()  -> preflight()      BEFORE the first model call (normalizeTopic)
 *   runGeneration()      -> consumeQuota()   AFTER the stories insert returns without error
 *
 * Nothing between those two points consumes anything, so every refusal, every gate discard
 * and every model failure is free to the parent.
 */
export interface QuotaService {
  /** Before any expensive work. Never moves the counter. */
  preflight(familyId: string): Promise<QuotaState>
  /** Read-only view, for GET /api/quota. Never moves the counter. */
  quotaStatus?(familyId: string): Promise<QuotaState>
  /** Called ONLY after a story row is successfully inserted. */
  consumeQuota(familyId: string): Promise<QuotaState>
}

/** Lane 3 not yet wired on this branch: allow, and be explicit that nothing was counted. */
export class UnmeteredQuotaService implements QuotaService {
  readonly isStub = true
  async preflight(): Promise<QuotaState> {
    return this.state(0)
  }
  async quotaStatus(): Promise<QuotaState> {
    return this.state(0)
  }
  async consumeQuota(): Promise<QuotaState> {
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
  /** For `guardrail_events` and cost attribution. */
  familyId?: string | null
  sink?: GenerationLogSink
}

export interface InputGuard {
  /** L1 + L2. Returns the classification; the pipeline maps `refuse` onto the SSE codes. */
  check(input: GuardInput): Promise<InputClassification>
}

/** Lane 6 not yet wired on this branch. Allow, and say so rather than imply a check ran. */
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
  /**
   * Test seams forwarded to `getOrBuildFactPack`, so a pipeline test can run against a fixed
   * pack instead of building a real one - or writing a fake pack into the globally shared
   * `fact_packs` table, where another lane would then find it. Unset in production.
   */
  factPackBuilder?: GetOrBuildOptions['builder']
  factPackReviewer?: GetOrBuildOptions['reviewer']
  now?: () => Date
  /**
   * The writing model for this run, for the F14 bake-off (each contestant writes through the
   * real pipeline). Unset in production, where `config/models.json`'s `writer` role decides.
   */
  writingModel?: string
}

export function resolveQuota(deps: GenerationDeps): QuotaService {
  return deps.quota ?? new UnmeteredQuotaService()
}

export function resolveGuard(deps: GenerationDeps): InputGuard {
  return deps.inputGuard ?? new PermissiveInputGuard()
}
