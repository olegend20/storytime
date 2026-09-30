/**
 * The fact pack's shape as a structured-output schema for stage 2 of the build. Lengths,
 * counts and the id patterns are not expressible here; the review pass (review.ts) and the
 * zod `FactPack` schema enforce them, and `test/unit/factpack-build.test.ts` keeps this in
 * step with `FactPack` key for key.
 */
const string = { type: 'string' } as const

function object(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
}

export const FACT_PACK_JSON_SCHEMA = object({
  topic_key: string,
  topic_label: string,
  summary: string,
  facts: {
    type: 'array',
    items: object({
      id: string,
      text: string,
      kid_safe: { type: 'boolean' },
      min_age: { type: 'integer' },
      confidence: { type: 'string', enum: ['high', 'medium', 'legend'] },
      source_ids: { type: 'array', items: string },
    }),
  },
  timeline: { type: 'array', items: object({ year: { type: 'integer' }, event: string }) },
  characters: {
    type: 'array',
    items: object({ name: string, role: string, kid_friendly_note: string }),
  },
  sensitive_notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  sources: { type: 'array', items: object({ id: string, title: string, url: string }) },
})

export const FACT_PACK_OUTPUT_FORMAT = { type: 'json_schema', schema: FACT_PACK_JSON_SCHEMA } as const

/** The knowledge stage: the pack plus the model's own account of how well it knows the topic. */
export const KNOWLEDGE_PACK_JSON_SCHEMA = object({
  coverage: { type: 'string', enum: ['solid', 'partial', 'unknown'] },
  ...(FACT_PACK_JSON_SCHEMA.properties as Record<string, unknown>),
})

export const KNOWLEDGE_PACK_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: KNOWLEDGE_PACK_JSON_SCHEMA,
} as const
