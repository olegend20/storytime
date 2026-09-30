import { z } from 'zod'
import { Confidence, FactPackStatus } from './common'

/**
 * Topic Fact Pack - IMPLEMENTATION_PLAN.md s4.3.
 *
 * Built ONCE per topic and shared globally by every family. This is what makes research
 * cost scale with the topic library rather than with stories generated. The fact-pack
 * builder is the only step permitted to use the web_search tool.
 */

export const FACT_PACK_MIN_FACTS = 12
export const FACT_PACK_MAX_FACTS = 40
export const FACT_PACK_TOKEN_LIMIT = 2000

export const FactSource = z.object({
  id: z.string().regex(/^s\d+$/, 'source ids look like s1, s2, ...'),
  title: z.string().trim().min(1).max(240),
  url: z.string().url(),
})
export type FactSource = z.infer<typeof FactSource>

export const Fact = z.object({
  id: z.string().regex(/^f\d+$/, 'fact ids look like f1, f2, ...'),
  text: z.string().trim().min(1).max(600),
  kid_safe: z.boolean(),
  /** Gate check: a True Facts item must have min_age <= the youngest selected child. */
  min_age: z.number().int().min(1).max(17),
  confidence: Confidence,
  /**
   * Pages the fact came from, when the pack was researched. Empty for a pack written from
   * the model's own knowledge - the default since 2026-09-29 (owner decision, DECISIONS
   * #139): a children's story does not need a URL behind every fact, and requiring one
   * made every new topic a nine-minute wait.
   */
  source_ids: z.array(z.string()).default([]),
})
export type Fact = z.infer<typeof Fact>

export const TimelineEntry = z.object({
  year: z.number().int(),
  event: z.string().trim().min(1).max(300),
})

export const FactPackCharacter = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  kid_friendly_note: z.string().trim().max(300),
})

export const FactPack = z
  .object({
    topic_key: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'topic_key must be kebab-case'),
    topic_label: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(800),
    facts: z.array(Fact).min(FACT_PACK_MIN_FACTS).max(FACT_PACK_MAX_FACTS),
    timeline: z.array(TimelineEntry).max(40).default([]),
    characters: z.array(FactPackCharacter).max(20).default([]),
    /** GUARDRAILS.md s3.3 care_notes land here and flow into the writer's request block. */
    sensitive_notes: z.string().trim().max(800).nullable().default(null),
    /** Empty for a knowledge pack; the pages a researched pack drew on. */
    sources: z.array(FactSource).default([]),
  })
  .superRefine((pack, ctx) => {
    const sourceIds = new Set(pack.sources.map((s) => s.id))
    const factIds = new Set<string>()
    for (const fact of pack.facts) {
      if (factIds.has(fact.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate fact id ${fact.id}`, path: ['facts'] })
      }
      factIds.add(fact.id)
      for (const sid of fact.source_ids) {
        if (!sourceIds.has(sid)) {
          ctx.addIssue({
            code: 'custom',
            message: `fact ${fact.id} cites unknown source ${sid}`,
            path: ['facts'],
          })
        }
      }
      // GUARDRAILS.md s3.3 / F5 review: an unsafe fact must carry handling guidance.
      if (!fact.kid_safe && !pack.sensitive_notes) {
        ctx.addIssue({
          code: 'custom',
          message: `fact ${fact.id} is kid_safe:false but the pack has no sensitive_notes`,
          path: ['sensitive_notes'],
        })
      }
    }
  })
export type FactPack = z.infer<typeof FactPack>

export const FactPackRecord = z.object({
  id: z.string().uuid(),
  topic_key: z.string(),
  topic_label: z.string(),
  content: FactPack,
  sources: z.array(FactSource),
  model: z.string(),
  version: z.number().int().positive(),
  use_count: z.number().int().nonnegative(),
  quality_score: z.number().nullable(),
  status: FactPackStatus,
})
export type FactPackRecord = z.infer<typeof FactPackRecord>

/** Haiku review pass output (F5). */
export const FactPackReview = z.object({
  accept: z.boolean(),
  quality_score: z.number().min(0).max(5),
  reasons: z.array(z.string().max(300)).default([]),
})
export type FactPackReview = z.infer<typeof FactPackReview>

/** Topic normalization output (F5 / s4.3). */
export const TopicNormalization = z.object({
  topic_key: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  topic_label: z.string().trim().min(1).max(120),
  is_appropriate_for_children: z.boolean(),
  reason: z.string().trim().max(300),
})
export type TopicNormalization = z.infer<typeof TopicNormalization>
