import { callModel, parseJsonLoose, type GenerationLogSink } from '@/lib/ai'
import { dataBlock } from '@/lib/datablock'
import { HARD_RULE_TEXT } from '@/lib/guardrails/prompt'
import { loadPrompt } from '@/lib/prompts'
import { splitSentences } from '@/lib/quality/actions'
import type { OutputViolation, StoryOutput } from '@/lib/schemas'

/**
 * Issue #32, rungs 1 and 2: a story that broke a hard safety rule is mended, not discarded.
 *
 * The gate knows the rule and the offending quote. Rung 1 (`mendStory`) asks the helper
 * model to rewrite just the sentences that hold those quotes - one call, seconds, about a
 * cent - and leaves every other sentence byte-identical. Rung 2 (`cutViolations`) is the
 * free fallback when a breach survives: the sentences holding the quotes are removed
 * outright. A story can lose a sentence; a parent does not lose the night.
 *
 * Neither step relaxes a rule. What ships afterwards is re-scanned by the gate, and a breach
 * that survives both is still a discard - the only one left.
 */

export interface Passage {
  chapter: number
  /** The exact sentence(s) in the chapter text that hold the quote. */
  text: string
  rule: number
}

/** The quote as the scanner gives it, without its ellipses, trimmed. */
function bareQuote(quote: string): string {
  return quote.replace(/^…|…$/g, '').replace(/^\.\.\.|\.\.\.$/g, '').trim()
}

/**
 * Where a violation's quote lives: the chapter and the sentence(s) that contain it. The
 * deterministic scanner's quote is a window around the match (`quoteAround`), so it is
 * tried whole, then by its own sentences, then by its longest words-run that the text has.
 */
export function locateViolation(story: StoryOutput, violation: OutputViolation): Passage | null {
  const quote = bareQuote(violation.quote)
  if (quote === '') return null
  const candidates = [quote, ...splitSentences(quote).filter((s) => s.length >= 12)]
  for (const needle of candidates) {
    for (const [chapter, ch] of story.chapters.entries()) {
      const at = ch.text.indexOf(needle)
      if (at === -1) continue
      // Expand to whole sentences around the hit.
      const sentences = splitSentences(ch.text)
      const hit: string[] = []
      let cursor = 0
      for (const sentence of sentences) {
        const start = ch.text.indexOf(sentence, cursor)
        if (start === -1) continue
        const end = start + sentence.length
        cursor = end
        if (end > at && start < at + needle.length) hit.push(sentence)
      }
      if (hit.length > 0) return { chapter, text: hit.join(' '), rule: violation.rule }
    }
  }
  return null
}

/** One passage per distinct (chapter, text), so overlapping quotes do not fight. */
export function passagesFor(story: StoryOutput, violations: readonly OutputViolation[]): Passage[] {
  const seen = new Set<string>()
  const out: Passage[] = []
  for (const v of violations) {
    if (v.severity !== 'hard') continue
    const p = locateViolation(story, v)
    if (!p) continue
    const key = `${p.chapter}:${p.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/** Replace `find` with `replace` inside a chapter's text, once, where the text has it. */
function applyEdit(story: StoryOutput, edit: { chapter: number; find: string; replace: string }): StoryOutput | null {
  const ch = story.chapters[edit.chapter]
  if (!ch) return null
  const at = ch.text.indexOf(edit.find)
  if (at === -1) return null
  const text = ch.text.slice(0, at) + edit.replace + ch.text.slice(at + edit.find.length)
  const chapters = story.chapters.map((c, i) => (i === edit.chapter ? { ...c, text } : c))
  return { ...story, chapters }
}

/** Remove a passage from its chapter, tidying the whitespace it leaves. */
function removePassage(story: StoryOutput, passage: Passage): StoryOutput | null {
  const ch = story.chapters[passage.chapter]
  if (!ch) return null
  const at = ch.text.indexOf(passage.text)
  if (at === -1) return null
  const text = (ch.text.slice(0, at) + ch.text.slice(at + passage.text.length))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +\n/g, '\n')
    .trim()
  if (text === '') return null // a chapter cannot be emptied; leave it to the discard
  const chapters = story.chapters.map((c, i) => (i === passage.chapter ? { ...c, text } : c))
  return { ...story, chapters }
}

export interface MendOptions {
  sink?: GenerationLogSink
  familyId?: string | null
  storyId?: string | null
  signal?: AbortSignal
}

export interface MendResult {
  story: StoryOutput
  /** Sentences rewritten by the model and applied. */
  edits: number
  /** Passages the model was asked about. */
  passages: number
  costUsd: number
}

const MendReply = {
  parse(raw: unknown): { chapter: number; find: string; replace: string }[] {
    if (!raw || typeof raw !== 'object') return []
    const edits = (raw as { edits?: unknown }).edits
    if (!Array.isArray(edits)) return []
    return edits
      .filter(
        (e): e is { chapter: number; find: string; replace: string } =>
          !!e &&
          typeof e === 'object' &&
          Number.isInteger((e as { chapter?: unknown }).chapter) &&
          typeof (e as { find?: unknown }).find === 'string' &&
          typeof (e as { replace?: unknown }).replace === 'string',
      )
      .map((e) => ({ chapter: e.chapter, find: e.find, replace: e.replace.trim() }))
      .filter((e) => e.find !== '' && e.replace !== '' && e.replace.length <= e.find.length * 3 + 200)
  },
}

export const MEND_MAX_TOKENS = 4_000

/** The user message of the mend call, from the passages (exported so a test can key a fixture). */
export function mendUserMessage(passages: readonly Passage[]): string {
  const rules = [...new Set(passages.map((p) => p.rule))]
    .map((n) => `${n}. ${HARD_RULE_TEXT[n] ?? ''}`)
    .join('\n')
  const listed = passages
    .map((p, i) => `[${i + 1}] chapter ${p.chapter}, rule ${p.rule}:\n${p.text}`)
    .join('\n\n')
  return [dataBlock('rules', rules), dataBlock('passages', listed), 'Return the edits JSON only.'].join('\n\n')
}

/**
 * Rung 1. One helper call rewrites the sentences that hold the violations' quotes; the
 * rest of the story is untouched. Returns the story unchanged (edits 0) when nothing could
 * be located or the model's edits could not be applied - the caller then cuts.
 */
export async function mendStory(
  story: StoryOutput,
  violations: readonly OutputViolation[],
  opts: MendOptions = {},
): Promise<MendResult> {
  const passages = passagesFor(story, violations)
  if (passages.length === 0) return { story, edits: 0, passages: 0, costUsd: 0 }

  const result = await callModel({
    purpose: 'mend',
    role: 'helper',
    system: [{ text: loadPrompt('mend').body }],
    messages: [{ role: 'user', content: mendUserMessage(passages) }],
    maxTokens: MEND_MAX_TOKENS,
    familyId: opts.familyId ?? null,
    storyId: opts.storyId ?? null,
    ...(opts.sink ? { sink: opts.sink } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  let mended = story
  let edits = 0
  for (const edit of MendReply.parse(parseJsonLoose(result.text))) {
    // Only passages we asked about may change, and only where the text still has them.
    if (!passages.some((p) => p.chapter === edit.chapter && p.text.includes(edit.find))) continue
    const next = applyEdit(mended, edit)
    if (!next) continue
    mended = next
    edits += 1
  }
  return { story: mended, edits, passages: passages.length, costUsd: result.costUsd }
}

/**
 * Rung 2. Remove the sentences that hold the violations' quotes. Free, deterministic, and
 * the last thing tried before a discard. Returns how many passages went.
 */
export function cutViolations(
  story: StoryOutput,
  violations: readonly OutputViolation[],
): { story: StoryOutput; cut: number } {
  let out = story
  let cut = 0
  for (const passage of passagesFor(story, violations)) {
    const next = removePassage(out, passage)
    if (!next) continue
    out = next
    cut += 1
  }
  return { story: out, cut }
}
