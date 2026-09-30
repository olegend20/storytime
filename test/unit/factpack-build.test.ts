import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

/**
 * The two-stage fact-pack build (DECISIONS #137): parallel one-search research calls, then
 * one no-tools write with the format enforced. The model layer is stubbed; what is asserted
 * is the shape of every call, because that shape is where the 9 minutes went.
 */

type Call = Record<string, unknown>
const calls = vi.hoisted(() => ({ made: [] as Call[], failAngles: [] as number[], reject400: false }))

vi.mock('@/lib/ai', async (orig) => {
  const actual = await orig<typeof import('@/lib/ai')>()
  return {
    ...actual,
    callModel: async (opts: Call) => {
      const index = calls.made.push(opts) - 1
      const research = Array.isArray(opts.tools)
      if (research) {
        const angleIndex = calls.made.filter((c) => Array.isArray(c.tools)).length - 1
        if (calls.failAngles.includes(angleIndex)) throw new Error('search unavailable')
        const text = JSON.stringify({
          findings: [
            { fact: `Fact ${index} from angle ${angleIndex}.`, source_title: `Page ${angleIndex}`, source_url: `https://example.org/${angleIndex}` },
            { fact: `Another fact ${index}.`, source_title: `Page ${angleIndex}`, source_url: `https://example.org/${angleIndex}` },
          ],
          care: '',
        })
        return { text, data: null, usage: { input_tokens: 50_000, output_tokens: 400, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 1 }, costUsd: 0.11, latencyMs: 20_000, model: opts.model, stopReason: 'end_turn', replayed: false, raw: { content: [{ type: 'text', text }] } }
      }
      if (calls.reject400 && (opts.outputConfig as Call | undefined)?.format) {
        throw new actual.ModelCallError('output_config.format: not supported', { purpose: 'factpack', model: String(opts.model), attempts: 1, retryable: false, status: 400 })
      }
      const text = JSON.stringify({ topic_key: 'x', topic_label: 'y', summary: 's', facts: [], timeline: [], characters: [], sensitive_notes: null, sources: [] })
      return { text, data: null, usage: { input_tokens: 3_000, output_tokens: 1_500, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 0 }, costUsd: 0.02, latencyMs: 25_000, model: opts.model, stopReason: 'end_turn', replayed: false, raw: { content: [{ type: 'text', text }] } }
    },
  }
})

const { buildFactPack, RESEARCH_ANGLES, findingsBlocks } = await import('@/lib/topics/build')
const { FACT_PACK_JSON_SCHEMA } = await import('@/lib/topics/pack-schema')
const { FactPack } = await import('@/lib/schemas')

afterEach(() => {
  calls.made.length = 0
  calls.failAngles = []
  calls.reject400 = false
})

describe('buildFactPack', () => {
  it('runs one low-effort, single-search call per angle, then one no-tools write with the format enforced', async () => {
    const result = await buildFactPack('bees', 'How bees make honey', { model: 'claude-sonnet-5' })

    const research = calls.made.filter((c) => Array.isArray(c.tools))
    const write = calls.made.filter((c) => !Array.isArray(c.tools))
    expect(research).toHaveLength(RESEARCH_ANGLES.length)
    expect(write).toHaveLength(1)
    for (const c of research) {
      expect((c.tools as Call[])[0]!.max_uses).toBe(1)
      expect(c.effort).toBe('low')
      expect(c.maxTokens).toBeLessThanOrEqual(3_000)
      expect(c.timeoutMs).toBeLessThan(300_000)
    }
    expect((write[0]!.outputConfig as Call).format).toMatchObject({ type: 'json_schema' })
    const content = String((write[0]!.messages as { content: string }[])[0]!.content)
    expect(content.match(/<findings>/g)).toHaveLength(RESEARCH_ANGLES.length)

    expect(result.webSearches).toBe(RESEARCH_ANGLES.length)
    expect(result.costUsd).toBeCloseTo(0.11 * RESEARCH_ANGLES.length + 0.02, 6)
    expect((result.candidate as { topic_key: string }).topic_key).toBe('bees')
    expect(result.latencyMs?.research).toBeGreaterThanOrEqual(0)
  })

  it('tolerates a failed angle and still writes from the rest', async () => {
    calls.failAngles = [1]
    const result = await buildFactPack('bees', 'How bees make honey', { model: 'claude-sonnet-5' })
    expect(result.webSearches).toBe(RESEARCH_ANGLES.length - 1)
    const write = calls.made.filter((c) => !Array.isArray(c.tools))[0]!
    expect(String((write.messages as { content: string }[])[0]!.content).match(/<findings>/g)).toHaveLength(RESEARCH_ANGLES.length - 1)
  })

  it('refuses to write a pack from too little research', async () => {
    calls.failAngles = [0, 1, 2]
    await expect(buildFactPack('bees', 'How bees make honey', { model: 'claude-sonnet-5' })).rejects.toThrow(
      /found too little: 1 of 4 angles/,
    )
    expect(calls.made.filter((c) => !Array.isArray(c.tools))).toHaveLength(0)
  })

  it('falls back to a plain write if the model rejects the output format', async () => {
    calls.reject400 = true
    const result = await buildFactPack('bees', 'How bees make honey', { model: 'claude-sonnet-5' })
    const writes = calls.made.filter((c) => !Array.isArray(c.tools))
    expect(writes).toHaveLength(2)
    expect(writes[1]!.outputConfig).toBeUndefined()
    expect(result.candidate).toBeTruthy()
  })
})

describe('the pack output schema matches FactPack key for key', () => {
  function keysOf(schema: z.ZodTypeAny): string[] {
    const inner = (s: z.ZodTypeAny): z.ZodTypeAny =>
      s instanceof z.ZodNullable || s instanceof z.ZodOptional || s instanceof z.ZodDefault
        ? inner(s.unwrap() as z.ZodTypeAny)
        : s
    const t = inner(schema)
    return t instanceof z.ZodObject ? Object.keys(t.shape) : []
  }
  it('at the top level and inside facts', () => {
    const top = FACT_PACK_JSON_SCHEMA.properties as Record<string, { properties?: Record<string, unknown>; items?: { properties: Record<string, unknown> } }>
    expect(Object.keys(top)).toEqual(keysOf(FactPack))
    const factShape = (FactPack as unknown as { shape: Record<string, z.ZodTypeAny> }).shape
    const factsElement = ((factShape.facts as z.ZodTypeAny) as unknown as { element: z.ZodTypeAny }).element
    expect(Object.keys(top.facts!.items!.properties)).toEqual(keysOf(factsElement))
  })

  it('renders findings as data blocks', () => {
    const block = findingsBlocks([{ angle: 'a', findings: [{ fact: 'f', source_title: 't', source_url: 'https://x' }], care: '' }])
    expect(block).toMatch(/^<findings>/)
  })
})
