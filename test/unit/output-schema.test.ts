import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { STORY_JSON_SCHEMA, STORY_OUTPUT_FORMAT } from '@/lib/generate/output-schema'
import { StoryOutput } from '@/lib/schemas'
import { goodStoryRaw } from '../helpers/story'

/**
 * The structured-output schema and the zod contract describe the same shape, key for key.
 * If `StoryOutput` gains a field, this fails until the API is told about it too.
 */

type Node = {
  type?: string
  properties?: Record<string, Node>
  required?: string[]
  additionalProperties?: boolean
  items?: Node
  anyOf?: Node[]
  enum?: string[]
}

/** Unwrap nullable / optional / default wrappers to the object or array underneath. */
function inner(s: z.ZodTypeAny): z.ZodTypeAny {
  if (s instanceof z.ZodNullable || s instanceof z.ZodOptional || s instanceof z.ZodDefault) {
    return inner(s.unwrap() as z.ZodTypeAny)
  }
  return s
}

function walk(json: Node, zod: z.ZodTypeAny, path: string, seen: string[]): void {
  const target = inner(zod)
  if (json.type === 'object') {
    expect(target, path).toBeInstanceOf(z.ZodObject)
    const shape = (target as z.ZodObject).shape as Record<string, z.ZodTypeAny>
    const keys = Object.keys(shape)
    expect(Object.keys(json.properties ?? {}), path).toEqual(keys)
    expect(json.required, path).toEqual(keys)
    expect(json.additionalProperties, path).toBe(false)
    for (const key of keys) walk(json.properties![key]!, shape[key]!, `${path}.${key}`, seen)
  } else if (json.type === 'array') {
    expect(target, path).toBeInstanceOf(z.ZodArray)
    walk(json.items!, (target as z.ZodArray).element as z.ZodTypeAny, `${path}[]`, seen)
  }
  seen.push(path)
}

describe('the structured-output schema', () => {
  it('matches StoryOutput key for key, in order, with no extra properties allowed', () => {
    const seen: string[] = []
    walk(STORY_JSON_SCHEMA, StoryOutput, 'story', seen)
    expect(seen).toContain('story.chapters[].shout_line')
    expect(seen).toContain('story.bible_suggestions.new_recurring[].type')
  })

  it('uses nothing the structured-output grammar cannot express', () => {
    const banned = /"(minLength|maxLength|minItems|maxItems|pattern|minimum|maximum|format|uniqueItems)"/
    expect(JSON.stringify(STORY_JSON_SCHEMA)).not.toMatch(banned)
    expect(STORY_OUTPUT_FORMAT.type).toBe('json_schema')
  })

  it('accepts a known-good story and its nulls', () => {
    // A minimal structural validator: types and required keys, the guarantee the API gives.
    const check = (node: Node, value: unknown, path: string): void => {
      if (node.anyOf) {
        const ok = node.anyOf.some((alt) => (alt.type === 'null' ? value === null : typeof value === alt.type))
        expect(ok, path).toBe(true)
        return
      }
      if (node.type === 'object') {
        expect(typeof value, path).toBe('object')
        const record = value as Record<string, unknown>
        for (const key of node.required ?? []) check(node.properties![key]!, record[key], `${path}.${key}`)
        return
      }
      if (node.type === 'array') {
        expect(Array.isArray(value), path).toBe(true)
        for (const [i, item] of (value as unknown[]).entries()) check(node.items!, item, `${path}[${i}]`)
        return
      }
      expect(typeof value, path).toBe(node.type)
      if (node.enum) expect(node.enum, path).toContain(value)
    }
    const story = goodStoryRaw()
    story.subtitle = null
    check(STORY_JSON_SCHEMA, story, 'story')
  })
})
