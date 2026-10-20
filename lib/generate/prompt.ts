import type Anthropic from '@anthropic-ai/sdk'
import type { CacheableBlock } from '@/lib/ai'
import { estimateTokens, loadPrompt } from '@/lib/prompts'
import { dataBlock, escapeForDataBlock, field } from '@/lib/datablock'
import { serializeBible } from '@/lib/bible/limits'
import {
  countWords,
  STORY_MAX_CHAPTERS,
  STORY_MIN_CHAPTERS,
  type Chapter,
  type FactPack,
  type GenerationRequest,
  type StoryBible,
} from '@/lib/schemas'

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
export function factPackForWriter(pack: FactPack | null, youngestAge?: number): unknown {
  if (!pack) return null
  // A fact the youngest child is too young for, or one the pack marks not kid-safe, is not
  // shown at all: the gate fails a story that cites it (fact_min_age, fact_not_kid_safe), the
  // reviewer fails one that tells it, and a writer cannot use what it is not given.
  const usable = pack.facts.filter((f) => f.kid_safe && (youngestAge === undefined || f.min_age <= youngestAge))
  return {
    topic_key: pack.topic_key,
    topic_label: pack.topic_label,
    summary: pack.summary,
    facts: usable.map((f) => ({
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
 * The narrative words the writer is asked for: the top of the range, not the middle
 * (2026-10-08). With the aim at 70% of the range the writer delivered 60-70% of it in 6 of 8
 * eval stories, most below the minimum. The gate's +15% tolerance above the maximum leaves
 * room should a draft overshoot.
 */
function aimWords(target: { max: number }): number {
  return Math.round(target.max / 50) * 50
}

/**
 * A length the writer can actually hit. A model cannot count 1,500 words, but it can write
 * eight chapters of about 200 words. The aim sits in the upper part of the range because the
 * writer runs short: the reference stories are 1,540-1,850 narrative words for a band-A
 * 10-minute story and the first three real drafts were 1,377, 1,083 and 1,197 - the second
 * failed the gate by 22 words and paid for a rewrite.
 */
export function lengthGuidance(target: { min: number; max: number }): string {
  const aim = aimWords(target)
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

/**
 * Our note beside the pack (prompts/fact-pack-note): the pack is written for grown-ups, and
 * first drafts copied its words into band-A stories unexplained. Outside the cached master
 * block, which is at its size limit; it is our text, with only the age filled in.
 */
export function factPackNote(youngestAge: number): string {
  return loadPrompt('fact-pack-note').body.trim().replaceAll('%AGE%', String(youngestAge))
}

/** The bible, the pack and the request: everything in the user message before the ask. */
function storyContext(input: BuildPromptInput): string[] {
  const youngestAge = Math.min(...input.request.children.map((c) => c.age))
  return [
    dataBlock('story_bible', serializeBible(input.bible)),
    dataBlock('fact_pack', JSON.stringify(factPackForWriter(input.factPack, youngestAge))),
    requestBlock(input.request),
    ...(input.factPack ? [factPackNote(youngestAge)] : []),
  ]
}

function withMaster(userContent: string): BuiltPrompt {
  const master = loadPrompt('master')
  return {
    // The ONLY cache breakpoint. §4.1: one static block, identical for every story call.
    system: [{ text: master.body, cache: true }],
    messages: [{ role: 'user', content: userContent }],
    masterPromptTokens: estimateTokens(master.body),
    masterPromptVersion: master.version,
  }
}

export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  return withMaster([...storyContext(input), 'Write the story now. Return the JSON object only.'].join('\n\n'))
}

/** What the parent already has on the page when a write drops partway (issue #74). */
export interface StorySoFar {
  title: string
  subtitle: string | null
  /** The chapters that arrived whole, in order. A chapter cut partway is not one of them. */
  chapters: Chapter[]
  /**
   * Every chapter is written - the drop came during the ending or the facts - so only those
   * are asked for (prompts/continue-ending), and any chapters in the reply are ignored.
   */
  chaptersComplete?: boolean
}

/**
 * The prompt for the rest of a story whose write dropped after chapters reached the parent
 * (issue #74): the same master block, bible, pack and request, then this story's own finished
 * chapters and prompts/continue in place of "Write the story now". Only this story's text -
 * never another story's (CLAUDE.md rule 8, the owner's reading 2026-10-19). Model-written, so
 * escaped like any other data.
 */
export function buildContinuationPrompt(input: BuildPromptInput & { soFar: StorySoFar }): BuiltPrompt {
  const { soFar } = input
  const words = soFar.chapters.reduce((n, c) => n + countWords(c.text), 0)
  const aim = aimWords(input.request.target_words)
  const ask = loadPrompt(soFar.chaptersComplete ? 'continue-ending' : 'continue')
    .body.trim()
    .replaceAll('%NEXT%', String(soFar.chapters.length + 1))
    .replaceAll('%LAST%', String(soFar.chapters.length))
    .replaceAll('%WORDS%', String(words))
    .replaceAll('%REMAINING%', String(Math.max(aim - words, 0)))
    .replaceAll('%MIN%', String(STORY_MIN_CHAPTERS))
    .replaceAll('%MAX%', String(STORY_MAX_CHAPTERS))
  const story = { title: soFar.title, subtitle: soFar.subtitle, chapters: soFar.chapters }
  return withMaster(
    [...storyContext(input), dataBlock('story_so_far', escapeForDataBlock(JSON.stringify(story))), ask].join('\n\n'),
  )
}
