import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseService } from '@/lib/supabase/service'
import { consumeQuota, preflight, quotaStatus, type QuotaSnapshot } from '@/lib/limits'
import { guardInput, reviewOutput, scanStoryStructure } from '@/lib/guardrails'
import { storyText, type InputClassification, type OutputSafetyReview } from '@/lib/schemas'
import type { SafetyReviewer } from '@/lib/quality/gate'
import type { GenerationDeps, GuardInput, InputGuard, QuotaService, QuotaState } from './deps'

/**
 * The real implementations behind `GenerationDeps`, for the route and the eval.
 *
 * `deps.ts` declared these seams so lanes 3 and 6 could land independently, with stubs that
 * allow everything until "the merge is a wiring change". The merge happened and the wiring
 * did not: `/api/stories/generate` ran with `PermissiveInputGuard` (no L1/L2), no L4 review
 * and `UnmeteredQuotaService` (no quota, no budget cap). These adapters are that wiring:
 * translation only - every decision stays in `lib/limits` and `lib/guardrails`.
 */

function toQuotaState(q: QuotaSnapshot, allowed: boolean): QuotaState {
  return {
    used: q.used,
    limit: q.limit,
    resets_at: q.resetsAt,
    allowed,
    generation_enabled: true,
  }
}

/** Lane 3 (F8): kill switch, then daily budget cap, then the family's daily quota. */
export class LimitsQuotaService implements QuotaService {
  constructor(private readonly db?: SupabaseClient) {}

  async preflight(familyId: string): Promise<QuotaState> {
    const r = await preflight({ familyId, ...(this.db ? { client: this.db } : {}) })
    if (r.ok) return toQuotaState(r.quota, true)

    const code = r.body.code
    if (code === 'service_paused' || code === 'budget_exceeded') {
      return {
        used: r.quota?.used ?? 0,
        limit: r.quota?.limit ?? 0,
        resets_at: r.body.resets_at ?? new Date().toISOString(),
        allowed: false,
        generation_enabled: false,
        disabled_reason: code,
      }
    }
    // quota_exceeded: `preflight` only blocks it once the quota has been read.
    return {
      ...toQuotaState(r.quota!, false),
      resets_at: r.body.resets_at ?? r.quota!.resetsAt,
    }
  }

  async quotaStatus(familyId: string): Promise<QuotaState> {
    const q = await quotaStatus({ familyId, ...(this.db ? { client: this.db } : {}) })
    return toQuotaState(q, q.remaining > 0)
  }

  async consumeQuota(familyId: string): Promise<QuotaState> {
    const c = await consumeQuota({ familyId, ...(this.db ? { client: this.db } : {}) })
    return toQuotaState(c, c.allowed)
  }
}

/** Lane 6 (F15): L1 deterministic, then the L2 Haiku classifier, events logged on refusal. */
export class GuardrailsInputGuard implements InputGuard {
  async check(input: GuardInput): Promise<InputClassification> {
    const youngest = [...input.children].sort((a, b) => a.age - b.age)[0]
    const r = await guardInput({
      topic_input: input.topicInput,
      children: input.children.map((c) => ({
        first_name: c.first_name,
        likes: c.likes ?? [],
        notes: c.notes ?? null,
      })),
      youngestAge: input.youngestAge,
      youngestName: youngest?.first_name ?? null,
      familyId: input.familyId ?? null,
      ...(input.sink ? { sink: input.sink } : {}),
    })
    return {
      decision: r.decision,
      category: r.category,
      care_notes: r.careNotes,
      min_recommended_age: r.classification?.min_recommended_age ?? 1,
      topic_key_hint: r.topicKeyHint,
      parent_message: r.parentMessage,
    }
  }
}

/**
 * Lane 6 (F15) L4, as F7's `SafetyReviewer`. Runs the deterministic structure scan and passes
 * its findings to the Haiku review as hints, the way `runOutputGate` does; a HARD
 * deterministic violation is merged into the result so it cannot be talked away by the model.
 */
export class GuardrailsSafetyReviewer implements SafetyReviewer {
  async review(
    ...[story, request, opts]: Parameters<SafetyReviewer['review']>
  ): Promise<OutputSafetyReview> {
    const childNames = request.children.map((c) => c.name)
    const structure = scanStoryStructure(story, { childNames })
    const { review } = await reviewOutput({
      storyText: storyText(story),
      band: request.age_band,
      childNames,
      hints: structure.violations,
      familyId: opts.familyId ?? null,
      storyId: opts.storyId ?? null,
      ...(opts.sink ? { sink: opts.sink } : {}),
    })
    const hard = structure.violations.filter((v) => v.severity === 'hard')
    if (hard.length === 0) return review
    return { ...review, safe: false, violations: [...review.violations, ...hard] }
  }
}

/** Everything production passes to `prepareGeneration` and `runGeneration`. */
export function productionDeps(db: SupabaseClient = supabaseService()): GenerationDeps {
  return {
    db,
    quota: new LimitsQuotaService(db),
    inputGuard: new GuardrailsInputGuard(),
    safetyReviewer: new GuardrailsSafetyReviewer(),
  }
}
