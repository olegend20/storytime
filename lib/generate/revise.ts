import { callModel, parseJsonLoose, type GenerationLogSink } from '@/lib/ai'
import { renderBandRubric } from '@/lib/bands'
import { dataBlock, escapeForDataBlock } from '@/lib/datablock'
import { HARD_RULE_TEXT } from '@/lib/guardrails/prompt'
import { loadPrompt } from '@/lib/prompts'
import { STORY_MIN_TRUE_FACTS, type FactPack, type GenerationRequest, type QualityResult, type StoryOutput } from '@/lib/schemas'
import { factPackForWriter } from './prompt'

/**
 * Issue #85: fix a failing first draft in place instead of rewriting it.
 *
 * The first draft streams to the parent as it is written. A full rewrite arrives in `done`
 * with a new title and new chapters, so the story the parent was reading is swapped. Most
 * drafts fail on a few sentences - a fact the pack does not give, a word never explained, a
 * child who only watches - so one call returns find/replace edits to those sentences, and the
 * pipeline runs the whole gate on the result again. Nothing is relaxed: an edited story that
 * still fails goes to the full rewrite exactly as before.
 *
 * Edits are bounded so a "revision" can never be a rewrite in disguise: the title, subtitle,
 * headings and chapter count never change, each `find` must occur once, and the total text
 * replaced is capped (REVISE_MAX_CHANGED_SHARE).
 */

export const REVISE_MAX_EDITS = 16
export const REVISE_EFFORT = 'medium' as const
/** The share of the story's characters the edits may replace, all together. */
export const REVISE_MAX_CHANGED_SHARE = 0.35
/** Thinking counts toward it; at the writer's default effort (high) 12k was spent before any edit. */
export const REVISE_MAX_TOKENS = 32_000

export interface ReviseEdit {
  part: 'chapter' | 'ending_line' | 'true_fact'
  index: number
  find: string
  replace: string
}

export interface ReviseOptions {
  /** The writing model, so a revision is in the story's own voice (deps.writingModel). */
  model?: string
  /**
   * How hard the writer thinks. Sonnet 5 thinks unprompted at its default (high) and spent a
   * 12k budget before writing an edit (bench, 2026-11-04); effort is the docs' lever for it.
   */
  effort?: 'low' | 'medium' | 'high'
  sink?: GenerationLogSink
  familyId?: string | null
  storyId?: string | null
  signal?: AbortSignal
}

export interface ReviseResult {
  story: StoryOutput
  /** Edits applied. 0 leaves the story unchanged. */
  edits: number
  /** Edits the model returned that could not be applied (not found, not unique, over a limit). */
  rejected: number
  /** Characters of the story replaced, for the bench and the logs. */
  changedChars: number
  costUsd: number
  /** Edits the reply held before any were applied, and why it stopped - for the bench. */
  proposed: number
  stopReason: string | null
  /** The reply as returned. It quotes the story: the bench reads it, nothing logs it. */
  text: string
}

/** What failed, as the editor is told it: the gate's own reasons and the located breaches. */
export function problemsFor(result: QualityResult): string[] {
  const out = [...result.rewrite_reasons]
  for (const v of result.safety?.violations ?? []) {
    out.push(`rule ${v.rule} (${HARD_RULE_TEXT[v.rule] ?? 'safety rule'}): "${v.quote}"`)
  }
  return [...new Set(out)]
}

function storyBlock(story: StoryOutput): string {
  const chapters = story.chapters.map((c, i) => `[chapter ${i}] ${c.heading}\n${c.text}`)
  const facts = story.true_facts.map((f, i) => `[true_fact ${i}] (${f.fact_id}) ${f.text}`)
  return [
    `title: ${story.title}`,
    ...chapters,
    `[ending_line 0] ${story.ending_line}`,
    ...facts,
  ].join('\n\n')
}

function requestBlock(request: GenerationRequest): string {
  const children = request.children.map((c) => `- ${c.name}, age ${c.age}`).join('\n')
  return `age band: ${request.age_band}\nnarrative words: ${request.target_words?.min ?? '?'}-${request.target_words?.max ?? '?'}\nchildren:\n${children}`
}

/** The user message of the revise call (exported so a test can key a fixture). */
export function reviseUserMessage(
  story: StoryOutput,
  result: QualityResult,
  request: GenerationRequest,
  pack: FactPack | null,
): string {
  const youngest = Math.min(...request.children.map((c) => c.age))
  return [
    dataBlock('story', escapeForDataBlock(storyBlock(story))),
    dataBlock('fact_pack', escapeForDataBlock(JSON.stringify(factPackForWriter(pack, youngest)))),
    dataBlock('request', escapeForDataBlock(requestBlock(request))),
    dataBlock('band_rules', renderBandRubric()),
    dataBlock('problems', escapeForDataBlock(problemsFor(result).map((p) => `- ${p}`).join('\n'))),
    'Return the edits JSON only.',
  ].join('\n\n')
}

function parseEdits(raw: unknown): ReviseEdit[] {
  if (!raw || typeof raw !== 'object') return []
  const edits = (raw as { edits?: unknown }).edits
  if (!Array.isArray(edits)) return []
  return edits.filter(
    (e): e is ReviseEdit =>
      !!e &&
      typeof e === 'object' &&
      ['chapter', 'ending_line', 'true_fact'].includes((e as ReviseEdit).part) &&
      Number.isInteger((e as ReviseEdit).index) &&
      typeof (e as ReviseEdit).find === 'string' &&
      typeof (e as ReviseEdit).replace === 'string' &&
      (e as ReviseEdit).find.trim() !== '',
  )
}

function occurrences(hay: string, needle: string): number {
  let n = 0
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) n++
  return n
}

function storyChars(story: StoryOutput): number {
  return (
    story.chapters.reduce((n, c) => n + c.text.length, 0) +
    story.ending_line.length +
    story.true_facts.reduce((n, f) => n + f.text.length, 0)
  )
}

/**
 * Apply the edits that are safe to apply, in order. An edit is dropped when its `find` is not
 * exactly once in its part, it would empty a chapter or the ending line, it would drop the
 * True Facts below the minimum, or it would take the total replaced past the cap. Title,
 * subtitle and headings are not addressable at all.
 */
export function applyRevisions(
  story: StoryOutput,
  edits: readonly ReviseEdit[],
): { story: StoryOutput; applied: number; rejected: number; changedChars: number } {
  const budget = storyChars(story) * REVISE_MAX_CHANGED_SHARE
  let out = story
  let applied = 0
  let rejected = 0
  let changed = 0
  const removedFacts = new Set<number>()
  for (const edit of edits.slice(0, REVISE_MAX_EDITS)) {
    const cost = Math.max(edit.find.length, edit.replace.trim().length)
    if (changed + cost > budget) {
      rejected++
      continue
    }
    const replace = edit.replace.trim()
    let next: StoryOutput | null = null
    if (edit.part === 'chapter') {
      const ch = out.chapters[edit.index]
      if (ch && occurrences(ch.text, edit.find) === 1 && replace !== '') {
        const text = ch.text.replace(edit.find, () => replace)
        if (text.trim() !== '') next = { ...out, chapters: out.chapters.map((c, i) => (i === edit.index ? { ...c, text } : c)) }
      }
    } else if (edit.part === 'ending_line') {
      if (edit.index === 0 && occurrences(out.ending_line, edit.find) === 1 && replace !== '') {
        next = { ...out, ending_line: out.ending_line.replace(edit.find, () => replace) }
      }
    } else {
      const fact = out.true_facts[edit.index]
      if (fact && !removedFacts.has(edit.index) && occurrences(fact.text, edit.find) === 1) {
        if (replace === '') {
          if (out.true_facts.length - removedFacts.size > STORY_MIN_TRUE_FACTS) {
            removedFacts.add(edit.index)
            next = out
          }
        } else {
          next = { ...out, true_facts: out.true_facts.map((f, i) => (i === edit.index ? { ...f, text: f.text.replace(edit.find, () => replace) } : f)) }
        }
      }
    }
    if (!next) {
      rejected++
      continue
    }
    out = next
    applied++
    changed += cost
  }
  // Removed last, so the indices the edits were written against never moved underneath them.
  if (removedFacts.size > 0) out = { ...out, true_facts: out.true_facts.filter((_, i) => !removedFacts.has(i)) }
  return { story: out, applied, rejected, changedChars: changed }
}

/** One call: edits for what the gate failed. The caller regates the result in full. */
export async function reviseStory(
  story: StoryOutput,
  result: QualityResult,
  request: GenerationRequest,
  pack: FactPack | null,
  opts: ReviseOptions = {},
): Promise<ReviseResult> {
  const call = await callModel({
    purpose: 'mend',
    role: 'writer',
    ...(opts.model ? { model: opts.model } : {}),
    system: [{ text: loadPrompt('revise').body }],
    messages: [{ role: 'user', content: reviseUserMessage(story, result, request, pack) }],
    maxTokens: REVISE_MAX_TOKENS,
    effort: opts.effort ?? REVISE_EFFORT,
    timeoutMs: 180_000,
    familyId: opts.familyId ?? null,
    storyId: opts.storyId ?? null,
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  let parsed: unknown = null
  try {
    parsed = parseJsonLoose(call.text)
  } catch {
    parsed = null
  }
  const proposed = parseEdits(parsed)
  const applied = applyRevisions(story, proposed)
  return {
    story: applied.story,
    edits: applied.applied,
    rejected: applied.rejected,
    changedChars: applied.changedChars,
    costUsd: call.costUsd,
    proposed: proposed.length,
    stopReason: call.stopReason ?? null,
    text: call.text,
  }
}

/** Rounds of revise-then-regate before giving up on a story (bench, 2026-11-04: one round fixed 22 of 45). */
export const REVISE_MAX_ROUNDS = 2
/** The share of the original story all rounds together may replace. */
export const REVISE_MAX_TOTAL_SHARE = 0.5

export interface RevisionGate {
  needsRewrite: boolean
  result: QualityResult
}

/**
 * Revise, regate, and - if the gate still fails and time allows - revise once more against
 * what the new verdict found. Returns the last story and verdict, `passed` when the gate no
 * longer wants a rewrite. The caller restores attempt 1 when it did not pass.
 */
export async function reviseInRounds<G extends RevisionGate>(
  story: StoryOutput,
  gate: G,
  opts: {
    revise: (story: StoryOutput, result: QualityResult) => Promise<ReviseResult>
    regate: (story: StoryOutput) => Promise<G>
    /** Checked before every round: false stops (the deadline). */
    canStart?: () => boolean
    rounds?: number
  },
): Promise<{ story: StoryOutput; gate: G; passed: boolean; edits: number; changedChars: number; rounds: number; costUsd: number }> {
  const budget = storyChars(story) * REVISE_MAX_TOTAL_SHARE
  let current = { story, gate }
  let edits = 0
  let changed = 0
  let rounds = 0
  let costUsd = 0
  while (current.gate.needsRewrite && rounds < (opts.rounds ?? REVISE_MAX_ROUNDS) && (opts.canStart?.() ?? true)) {
    rounds++
    const revised = await opts.revise(current.story, current.gate.result)
    costUsd += revised.costUsd
    if (revised.edits === 0 || changed + revised.changedChars > budget) break
    edits += revised.edits
    changed += revised.changedChars
    current = { story: revised.story, gate: await opts.regate(revised.story) }
  }
  return { ...current, passed: !current.gate.needsRewrite, edits, changedChars: changed, rounds, costUsd }
}
