import type Anthropic from '@anthropic-ai/sdk'
import type { CacheableBlock } from '@/lib/ai'
import { estimateTokens, loadPrompt } from '@/lib/prompts'
import { dataBlock, escapeForDataBlock, field } from '@/lib/datablock'
import { serializeBible } from '@/lib/bible/limits'
import type { FactPack, GenerationRequest, StoryBible } from '@/lib/schemas'

/**
 * The generation prompt (F6 / §4.1).
 *
 * Layout, and the reason for it:
 *
 *   system[0]  master prompt        <- LARGE, STATIC, cache_control: true
 *   messages[0] story bible         <- varies per series
 *               fact pack           <- varies per topic
 *               request             <- varies per story
 *
 * Everything before the cache breakpoint must be byte-identical on every call or the cache
 * never warms (§4.1: "identical for every story call"). Everything that varies therefore
 * lives in the user message, after it. This also satisfies GUARDRAILS.md §3.4: parent text
 * is never allowed to precede the system rules.
 */

export interface BuildPromptInput {
  request: GenerationRequest
  bible: StoryBible
  factPack: FactPack | null
}

export interface BuiltPrompt {
  system: CacheableBlock[]
  messages: Anthropic.MessageParam[]
  /** Estimated size of the cached block, for the cache-read ratio assertion (F6 AC). */
  masterPromptTokens: number
  masterPromptVersion: number
}

/**
 * The fact pack as the writer sees it. Sources are deliberately withheld: the writer never
 * needs a URL, and a URL in the prompt is an invitation to put one in the story - which the
 * gate then rejects (GUARDRAILS.md §4.2).
 */
export function factPackForWriter(pack: FactPack | null): unknown {
  if (!pack) return null
  return {
    topic_key: pack.topic_key,
    topic_label: pack.topic_label,
    summary: pack.summary,
    facts: pack.facts.map((f) => ({
      id: f.id,
      text: f.text,
      confidence: f.confidence,
      kid_safe: f.kid_safe,
      min_age: f.min_age,
    })),
    timeline: pack.timeline,
    characters: pack.characters,
    sensitive_notes: pack.sensitive_notes,
  }
}

/** One `<child_profile>` per child. Every value is parent-supplied, so every value is escaped. */
export function childProfileBlocks(request: GenerationRequest): string {
  return request.children
    .map((child) =>
      dataBlock(
        'child_profile',
        [
          field('name', child.name),
          field('age', child.age),
          field('likes', child.likes.join(', ')),
          field('notes', child.notes ?? null),
        ]
          .filter((line) => line !== '')
          .map((line) => `  ${line}`)
          .join('\n'),
      ),
    )
    .join('\n')
}

/**
 * A length the writer can actually hit. A model cannot count 1,500 words, but it can write
 * eight chapters of about 200 words. The aim sits in the upper part of the range because the
 * writer runs short: the reference stories are 1,540-1,850 narrative words for a band-A
 * 10-minute story and the first three real drafts were 1,377, 1,083 and 1,197 - the second
 * failed the gate by 22 words and paid for a rewrite.
 */
export function lengthGuidance(target: { min: number; max: number }): string {
  const aim = Math.round((target.min + 0.7 * (target.max - target.min)) / 50) * 50
  const per = (chapters: number) => Math.round(aim / chapters / 10) * 10
  return (
    `about ${aim} narrative words. With 8 chapters that is about ${per(8)} words each; ` +
    `with 10, about ${per(10)}. Count as you go: under-length is the most common failure.`
  )
}

export function requestBlock(request: GenerationRequest): string {
  const youngest = Math.min(...request.children.map((c) => c.age))
  const lines = [
    childProfileBlocks(request),
    field('age_band', request.age_band),
    field('youngest_age', youngest),
    field('tones', request.tones.join(', ')),
    field('length_minutes', request.length_minutes),
    field(
      'target_narrative_words',
      `${request.target_words.min}-${request.target_words.max}`,
    ),
    field('aim_for', lengthGuidance(request.target_words)),
    dataBlock('topic', escapeForDataBlock(request.topic_label)),
    request.avoid.length > 0
      ? dataBlock('avoid', request.avoid.map((a) => `- ${escapeForDataBlock(a)}`).join('\n'))
      : '',
    // Hard rule 7's one exception (issue #27). The names are escaped data; the rules beside
    // them are our own text, sent only with the few stories that need them so the cached
    // master block stays the same bytes for everyone.
    request.requested_characters.length > 0
      ? field('requested_characters', request.requested_characters.join(', '))
      : '',
    request.requested_characters.length > 0
      ? dataBlock('character_rules', loadPrompt('character-rules').body)
      : '',
    request.care_notes
      ? dataBlock('handle_with_care', escapeForDataBlock(request.care_notes))
      : '',
    request.rewrite_reasons.length > 0
      ? dataBlock(
          'rewrite_required',
          [
            'The previous attempt was rejected. Write a NEW story that fixes every point below.',
            ...request.rewrite_reasons.map((r) => `- ${escapeForDataBlock(r)}`),
          ].join('\n'),
        )
      : '',
  ].filter((line) => line !== '')

  return dataBlock('request', lines.join('\n'))
}

export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const master = loadPrompt('master')

  const userContent = [
    dataBlock('story_bible', serializeBible(input.bible)),
    dataBlock('fact_pack', JSON.stringify(factPackForWriter(input.factPack))),
    requestBlock(input.request),
    'Write the story now. Return the JSON object only.',
  ].join('\n\n')

  return {
    // The ONLY cache breakpoint. §4.1: one static block, identical for every story call.
    system: [{ text: master.body, cache: true }],
    messages: [{ role: 'user', content: userContent }],
    masterPromptTokens: estimateTokens(master.body),
    masterPromptVersion: master.version,
  }
}
