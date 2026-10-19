import { callModel, parseJsonLoose, type GenerationLogSink } from '@/lib/ai'
import { dataBlock } from '@/lib/datablock'
import { scanStoryText } from '@/lib/guardrails/output'
import { HARD_RULE_TEXT } from '@/lib/guardrails/prompt'
import { loadPrompt } from '@/lib/prompts'
import { splitSentences } from '@/lib/quality/actions'
import { STORY_MIN_TRUE_FACTS, type OutputViolation, type StoryOutput } from '@/lib/schemas'

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
  /** The exact sentence(s) in the chapter text that hold the quote: a raw slice of it. */
  text: string
  /** Where `text` starts in the chapter. */
  start: number
  rule: number
  /** Set when the quote is outside the chapter text; `chapter` is then that part's index. */
  part?: PassagePart
}

/** Does a sentence end here? A terminator, then closing quotes/brackets, then whitespace or the end. */
const SENTENCE_END = /[.!?]["'”’)\]]*(?=\s|$)/g

/** The raw slice of `text` holding the whole sentences that cover [at, at + length). */
function sentencesAround(text: string, at: number, length: number): { start: number; end: number } {
  // Backwards: the previous sentence end (or a paragraph break) before `at`.
  let start = 0
  const before = text.slice(0, at)
  const para = before.lastIndexOf('\n\n')
  SENTENCE_END.lastIndex = 0
  for (const m of before.matchAll(SENTENCE_END)) start = Math.max(start, m.index + m[0].length)
  start = Math.max(start, para === -1 ? 0 : para + 2)
  while (start < at && /\s/.test(text[start]!)) start++
  // Forwards: the next sentence end (or paragraph break) at or after the hit ends - or the
  // hit's own end, when it finishes its sentence ("grabbed his flipper.").
  const from = at + length
  if (/[.!?]["'”’)\]]*$/.test(text.slice(at, from)) && (from === text.length || /\s/.test(text[from]!))) {
    return { start, end: from }
  }
  const rest = text.slice(from)
  const nextPara = rest.indexOf('\n\n')
  SENTENCE_END.lastIndex = 0
  const m = SENTENCE_END.exec(rest)
  let end = text.length
  if (m) end = Math.min(end, from + m.index + m[0].length)
  if (nextPara !== -1) end = Math.min(end, from + nextPara)
  return { start, end }
}

/** The quote as the scanner gives it, without its ellipses, trimmed. */
function bareQuote(quote: string): string {
  return quote.replace(/^…|…$/g, '').replace(/^\.\.\.|\.\.\.$/g, '').trim()
}

/**
 * The parts of a story outside the chapter text that a quote can come from (issue #66):
 * the reviewer reads the whole story, facts list and all. None of them goes to the mend
 * model; the cut (rung 2) handles each one without inventing a word.
 */
export type PassagePart = 'subtitle' | 'heading' | 'shout_line' | 'ending_line' | 'true_fact'

/** The text with markdown emphasis dropped, quotes and dashes straightened and runs of
 * whitespace collapsed, and for each character kept, where it came from: a reviewer quotes
 * "On January 27" from "On **January 27**", and ’ as '. */
function normalized(text: string): { text: string; from: number[] } {
  let out = ''
  const from: number[] = []
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]!
    if (ch === '*') continue
    if (ch === '\u2018' || ch === '\u2019') ch = "'"
    else if (ch === '\u201c' || ch === '\u201d') ch = '"'
    else if (ch === '\u2013' || ch === '\u2014') ch = '-'
    else if (/\s/.test(ch)) {
      if (out.endsWith(' ')) continue
      ch = ' '
    }
    out += ch
    from.push(i)
  }
  return { text: out, from }
}

/** Where `needle` (already normalized) sits in `text`, as a range of the original text. */
function findNormalized(text: string, needle: string): { at: number; length: number } | null {
  const n = normalized(text)
  const at = n.text.indexOf(needle)
  if (at === -1 || needle === '') return null
  const start = n.from[at]!
  const end = n.from[at + needle.length - 1]! + 1
  return { at: start, length: end - start }
}

/** Every searchable part of the story: chapter text first, then the rest. */
function storyParts(story: StoryOutput): { part: PassagePart | null; index: number; text: string }[] {
  const parts: { part: PassagePart | null; index: number; text: string }[] = story.chapters.map((c, i) => ({
    part: null,
    index: i,
    text: c.text,
  }))
  if (story.subtitle) parts.push({ part: 'subtitle', index: 0, text: story.subtitle })
  story.chapters.forEach((c, i) => {
    parts.push({ part: 'heading', index: i, text: c.heading })
    if (c.shout_line) parts.push({ part: 'shout_line', index: i, text: c.shout_line })
  })
  parts.push({ part: 'ending_line', index: 0, text: story.ending_line })
  story.true_facts.forEach((f, i) => parts.push({ part: 'true_fact', index: i, text: f.text }))
  return parts
}

/** The shortest run of the quote's words that may place it, when it occurs once in the story. */
export const MIN_RUN_WORDS = 3

/**
 * Where a violation's quote lives: the chapter and the sentence(s) that contain it, or the
 * subtitle, a heading, a shout line, the ending line or a true fact (issue #66). The
 * deterministic scanner's quote is a window around the match (`quoteAround`), so it is
 * tried whole, then by its own sentences, then by its longest words-run that the text has.
 */
export function locateViolation(story: StoryOutput, violation: OutputViolation): Passage | null {
  const quote = normalized(bareQuote(violation.quote)).text.trim()
  if (quote === '') return null
  // The quote whole; then its own sentences; then its longest run of words the text has
  // (a reviewer paraphrases, quotes a sentence the mend already changed, or glues the rule's
  // own words onto the quote; a scanner's window straddles a paragraph break).
  // A run must occur exactly once in the whole story: "and the boys were" can sit in any
  // harmless sentence, and a cut placed on the wrong sentence would ship the breach while
  // removing an innocent line. Whatever the ladder changes is reviewed again before it ships.
  const parts = storyParts(story)
  const all = parts.map((p) => normalized(p.text).text).join('\n')
  const occursOnce = (needle: string) => {
    const first = all.indexOf(needle)
    return first !== -1 && all.indexOf(needle, first + 1) === -1
  }
  const words = quote.split(' ').filter((w) => w !== '')
  const runs: string[] = []
  for (let n = Math.min(words.length, 8); n >= MIN_RUN_WORDS; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      const run = words.slice(i, i + n).join(' ')
      if (occursOnce(run)) runs.push(run)
    }
  }
  // A quote's own sentences and paragraphs (a scanner window can hold a chapter heading).
  // A scanner quote is a window cut mid-sentence at both ends around the hit: the piece the
  // scanner flags goes first, then the pieces nearest the centre, so the hit is placed and
  // not the line beside it.
  const raw = bareQuote(violation.quote)
  const windowed = /^(?:…|\.\.\.)|(?:…|\.\.\.)$/.test(violation.quote.trim())
  const pieces = raw
    .split(/\n\s*\n/)
    .flatMap((para) => splitSentences(normalized(para).text))
    .filter((s) => s.length >= 12)
  const centre = normalized(raw).text.length / 2
  const flat = normalized(raw).text
  const distance = (piece: string) => {
    const at = flat.indexOf(piece)
    return at === -1 ? Number.MAX_SAFE_INTEGER : Math.abs(at + piece.length / 2 - centre)
  }
  // The piece the scanner itself flags for this rule holds the hit; the rest stand beside it.
  const flags = (piece: string) => scanStoryText(piece).hardViolations.some((v) => v.rule === violation.rule)
  const ordered = windowed
    ? [...pieces].sort((a, b) => Number(flags(b)) - Number(flags(a)) || distance(a) - distance(b))
    : pieces
  // A scanner window is tried by its pieces before whole: whole, it would cut the harmless
  // sentences on either side of the hit along with it.
  const candidates = windowed ? [...ordered, quote, ...runs] : [quote, ...ordered, ...runs]
  for (const needle of candidates) {
    for (const p of parts) {
      const hit = findNormalized(p.text, needle)
      if (!hit) continue
      if (p.part !== null) return { chapter: p.index, text: p.text, start: 0, rule: violation.rule, part: p.part }
      const { start, end } = sentencesAround(p.text, hit.at, hit.length)
      const text = p.text.slice(start, end)
      if (text.trim() === '') continue
      return { chapter: p.index, text, start, rule: violation.rule }
    }
  }
  return null
}

/**
 * One passage per distinct (chapter, start), so overlapping quotes do not fight, and the
 * hard violations that could not be placed at all - a quote the text does not contain.
 */
export function passagesFor(
  story: StoryOutput,
  violations: readonly OutputViolation[],
): { passages: Passage[]; unlocated: OutputViolation[] } {
  const seen = new Set<string>()
  const passages: Passage[] = []
  const unlocated: OutputViolation[] = []
  for (const v of violations) {
    if (v.severity !== 'hard') continue
    const p = locateViolation(story, v)
    if (!p) {
      unlocated.push(v)
      continue
    }
    const key = `${p.part ?? 'chapter'}:${p.chapter}:${p.start}`
    if (seen.has(key)) continue
    seen.add(key)
    passages.push(p)
  }
  return { passages, unlocated }
}

/** The occurrence of `needle` in `text` closest to `near` - an earlier edit may have moved it either way. */
function nearestIndexOf(text: string, needle: string, near: number): number {
  let best = -1
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) break
    if (best === -1 || Math.abs(at - near) < Math.abs(best - near)) best = at
    from = at + 1
  }
  return best
}

/**
 * Replace `find` with `replace` inside the passage it was asked about - never an earlier
 * look-alike elsewhere in the chapter. The passage is re-found by its text first, since an
 * earlier edit may have moved it.
 */
function applyEdit(
  story: StoryOutput,
  passage: Passage,
  edit: { find: string; replace: string },
): StoryOutput | null {
  const ch = story.chapters[passage.chapter]
  if (!ch) return null
  const passageAt = nearestIndexOf(ch.text, passage.text, passage.start)
  if (passageAt === -1) return null
  const within = ch.text.indexOf(edit.find, passageAt)
  if (within === -1 || within + edit.find.length > passageAt + passage.text.length) return null
  const text = ch.text.slice(0, within) + edit.replace + ch.text.slice(within + edit.find.length)
  const chapters = story.chapters.map((c, i) => (i === passage.chapter ? { ...c, text } : c))
  return { ...story, chapters }
}

/** Remove a passage from its chapter, tidying the whitespace it leaves. */
function removePassage(story: StoryOutput, passage: Passage): StoryOutput | null {
  const ch = story.chapters[passage.chapter]
  if (!ch) return null
  const at = nearestIndexOf(ch.text, passage.text, passage.start)
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

/**
 * Remove a part outside the chapter text (issue #66). Optional parts go; a true fact goes
 * while the story keeps its minimum; the required ending line and a heading are replaced
 * with plain words that add nothing ("The end.", "Chapter 3"), never with invented text.
 */
function removePart(story: StoryOutput, passage: Passage): StoryOutput | null {
  const i = passage.chapter
  switch (passage.part) {
    case 'subtitle':
      return { ...story, subtitle: null }
    case 'ending_line':
      return { ...story, ending_line: 'The end.' }
    case 'heading':
    case 'shout_line': {
      if (!story.chapters[i]) return null
      const chapters = story.chapters.map((c, k) =>
        k !== i ? c : passage.part === 'heading' ? { ...c, heading: `Chapter ${i + 1}` } : { ...c, shout_line: null },
      )
      return { ...story, chapters }
    }
    case 'true_fact': {
      if (!story.true_facts[i] || story.true_facts.length <= STORY_MIN_TRUE_FACTS) return null
      return { ...story, true_facts: story.true_facts.filter((_, k) => k !== i) }
    }
    default:
      return null
  }
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
  // Chapter sentences only: the rest (a fact, a heading, the ending line) is the cut's job,
  // which removes or replaces it without the model inventing a word.
  const passages = passagesFor(story, violations).passages.filter((p) => p.part === undefined)
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
  const done = new Set<Passage>()
  for (const edit of MendReply.parse(parseJsonLoose(result.text))) {
    // Only a passage we asked about may change, once, and only inside its own bounds.
    const passage = passages.find((p) => !done.has(p) && p.chapter === edit.chapter && p.text.includes(edit.find))
    if (!passage) continue
    const next = applyEdit(mended, passage, edit)
    if (!next) continue
    mended = next
    edits += 1
    done.add(passage)
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
): { story: StoryOutput; cut: number; complete: boolean } {
  const { passages, unlocated } = passagesFor(story, violations)
  let out = story
  let cut = 0
  let failed = 0
  // Outside the chapter text first (issue #66); their indices do not move as text goes.
  // True facts last-index first, so dropping one does not shift the next.
  const outside = passages.filter((p) => p.part !== undefined).sort((a, b) => b.chapter - a.chapter)
  for (const passage of outside) {
    const next = removePart(out, passage)
    if (!next) {
      failed += 1
      continue
    }
    out = next
    cut += 1
  }
  const inside = passages.filter((p) => p.part === undefined)
  // Last passage first, so earlier offsets stay valid as text is removed.
  for (const passage of [...inside].sort((a, b) => b.chapter - a.chapter || b.start - a.start)) {
    const next = removePassage(out, passage)
    if (!next) {
      failed += 1
      continue
    }
    out = next
    cut += 1
  }
  // Complete only when every hard violation was placed and every passage went: a story
  // with a breach still in it is never "cut".
  return { story: out, cut, complete: unlocated.length === 0 && failed === 0 && cut > 0 }
}
