/**
 * The story's shape, as a JSON Schema for structured outputs (`output_config.format`).
 *
 * With this on the request the API constrains the writer's reply to the schema: the keys,
 * the types, the `type` enum, no prose around the object, no markdown fence, no unescaped
 * line break inside a string. That is the class of failure that sent every one of the
 * owner's first stories to a paid repair call.
 *
 * What a structured-output schema CANNOT express - string lengths, array counts, the
 * `fact_id` pattern - is deliberately absent here. Those are stated to the writer in
 * master.v2 §8, fixed locally where that is safe (normalize.ts) and enforced by the zod
 * `StoryOutput` schema, which remains the contract. `test/unit/output-schema.test.ts` keeps
 * the two in step, key for key.
 *
 * Property ORDER matters: the reply is generated in this order, and the streaming reader
 * needs `title` and `subtitle` before `chapters`, and `heading` before `text`.
 */

const string = { type: 'string' } as const
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const

function object(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

export const STORY_JSON_SCHEMA = object({
  title: string,
  subtitle: nullableString,
  chapters: {
    type: 'array',
    items: object({ heading: string, text: string, shout_line: nullableString }),
  },
  ending_line: string,
  true_facts: {
    type: 'array',
    items: object({ text: string, fact_id: string }),
  },
  bible_suggestions: object({
    new_recurring: {
      type: 'array',
      items: object({
        name: string,
        type: { type: 'string', enum: ['device', 'character', 'place', 'object'] },
        rule: string,
      }),
    },
    ending_summary: string,
  }),
  estimated_read_minutes: { type: 'number' },
})

export const STORY_OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: STORY_JSON_SCHEMA,
} as const
