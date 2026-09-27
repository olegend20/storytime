import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { AgeBand, LengthMinutes, countWords, type StoryOutput } from '@/lib/schemas'

/**
 * Reader for storytime-plan/reference-stories/.
 *
 * The four reference stories are markdown, not model JSON, but they must be scoreable by
 * the same machinery as generated stories: F7's VT runs them through the deterministic
 * gate, and JUDGE_AGENT.md s5 scores them with their original requests. This parses the
 * markdown into the StoryOutput shape so both paths share one definition of "the story".
 *
 * Node-only (uses fs). Import from tests and from eval/, never from a browser bundle.
 */

export const REFERENCE_DIR = join(process.cwd(), 'storytime-plan', 'reference-stories')

export const ReferenceRequest = z.object({
  children: z.array(
    z.object({
      name: z.string(),
      age: z.number().int().optional(),
      age_band_note: z.string().optional(),
      likes: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }),
  ),
  youngest_age: z.number().int(),
  age_band: AgeBand,
  topic_input: z.string(),
  topic_key: z.string(),
  tones: z.array(z.string()),
  length_minutes: LengthMinutes,
})
export type ReferenceRequest = z.infer<typeof ReferenceRequest>

export const ReferenceEntry = z.object({
  file: z.string(),
  series: z.string(),
  sequence: z.number().int().positive(),
  request: ReferenceRequest,
  /** Series state BEFORE this story. Null for a first story. */
  bible_before: z.record(z.string(), z.unknown()).nullable(),
  expected_bible_additions: z.array(z.string()).default([]),
})
export type ReferenceEntry = z.infer<typeof ReferenceEntry>

export const ReferenceManifest = z.object({
  description: z.string(),
  written_by_model: z.string(),
  stories: z.array(ReferenceEntry),
  notes: z.array(z.string()).default([]),
})
export type ReferenceManifest = z.infer<typeof ReferenceManifest>

export function loadManifest(dir: string = REFERENCE_DIR): ReferenceManifest {
  const path = join(dir, 'manifest.json')
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. The reference stories define the quality bar and carry the original ` +
        `request for each story (JUDGE_AGENT.md s5). See storytime-plan/reference-stories/README.md.`,
    )
  }
  return ReferenceManifest.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/** Story files only - excludes manifest.json and our own README. */
export function referenceStoryFiles(dir: string = REFERENCE_DIR): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort()
}

export interface ParsedReference {
  title: string
  subtitle: string | null
  /** Everything before the first chapter heading: the cold open. */
  coldOpen: string
  chapters: { heading: string; text: string }[]
  endingLine: string | null
  /**
   * Which convention the story uses for its closing line. The references use two,
   * split cleanly by band:
   *  - 'bedtime_address' (band A): an italic line AFTER "The End", spoken to the child -
   *    "Goodnight, Cruz. Goodnight, Phoenix. Play well."
   *  - 'final_beat' (band C): the last prose line of the closing section, forward-looking
   *    rather than a goodnight - "Tomorrow, he had a game to make."
   * A direct bedtime address suits a 4-year-old; an older child gets a last beat instead.
   * The master prompt should pick per band rather than treating one as correct.
   */
  endingStyle: 'bedtime_address' | 'final_beat' | null
  trueFacts: string[]
  /** Chapter bodies + cold open + ending line. Excludes headings and the facts list. */
  narrativeWordCount: number
}

const MD_EMPHASIS = /\*\*|\*|__|`/g

function stripMarkdown(text: string): string {
  return text.replace(MD_EMPHASIS, '')
}

/**
 * Parse one reference story. The four files share a consistent shape:
 *   # Title
 *   *subtitle*
 *   <cold open prose>
 *   ## Chapter N: ... | ## Level N: ... | ## Loading...
 *   ## The End
 *   *Goodnight, ... .*
 *   ### True facts from the story
 *   - bullet
 */
export function parseReferenceStory(markdown: string): ParsedReference {
  const lines = markdown.split('\n')

  let title = ''
  let subtitle: string | null = null
  const chapters: { heading: string; text: string }[] = []
  const trueFacts: string[] = []
  let endingLine: string | null = null
  let endingStyle: ParsedReference['endingStyle'] = null

  let section: 'preamble' | 'coldopen' | 'chapter' | 'end' | 'facts' = 'preamble'
  const coldOpenLines: string[] = []
  let currentHeading = ''
  let currentBody: string[] = []

  const flushChapter = (): void => {
    if (currentHeading !== '') {
      chapters.push({ heading: currentHeading, text: currentBody.join('\n').trim() })
    }
    currentHeading = ''
    currentBody = []
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    const h1 = /^#\s+(.*)$/.exec(line)
    if (h1) {
      title = stripMarkdown(h1[1]!).trim()
      section = 'coldopen'
      continue
    }

    const heading = /^#{2,3}\s+(.*)$/.exec(line)
    if (heading) {
      const text = stripMarkdown(heading[1]!).trim()
      if (/^true facts/i.test(text)) {
        flushChapter()
        section = 'facts'
        continue
      }
      if (/^the end$/i.test(text)) {
        flushChapter()
        section = 'end'
        continue
      }
      flushChapter()
      currentHeading = text
      section = 'chapter'
      continue
    }

    if (/^\s*---\s*$/.test(line)) continue

    switch (section) {
      case 'coldopen': {
        // The first italic line after the title is the subtitle.
        const italic = /^\*([^*].*)\*$/.exec(line.trim())
        if (subtitle === null && italic && coldOpenLines.length === 0) {
          subtitle = italic[1]!.trim()
          continue
        }
        coldOpenLines.push(line)
        break
      }
      case 'chapter':
        currentBody.push(line)
        break
      case 'end': {
        const italic = /^\*(.+)\*$/.exec(line.trim())
        if (italic && endingLine === null) {
          endingLine = italic[1]!.trim()
          endingStyle = 'bedtime_address'
        }
        break
      }
      case 'facts': {
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
        if (bullet) trueFacts.push(stripMarkdown(bullet[1]!).trim())
        break
      }
      case 'preamble':
        break
    }
  }
  flushChapter()

  /**
   * Band C stories put their closing line at the end of the final section and leave
   * "The End" as a bare marker, so fall back to the last prose line of the last chapter.
   * Skip code fences: the lost-levels story ends its final section with an on-screen
   * message in a fenced block, which is set dressing rather than the closing line.
   */
  if (endingLine === null && chapters.length > 0) {
    const lastChapter = chapters[chapters.length - 1]!
    const candidates = lastChapter.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('```') && !l.startsWith('>'))
    const last = candidates[candidates.length - 1]
    if (last) {
      endingLine = stripMarkdown(last)
      endingStyle = 'final_beat'
    }
  }

  const coldOpen = stripMarkdown(coldOpenLines.join('\n')).trim()
  const narrativeWordCount =
    countWords(coldOpen) +
    chapters.reduce((sum, c) => sum + countWords(stripMarkdown(c.text)), 0) +
    countWords(endingLine ?? '')

  return {
    title,
    subtitle,
    coldOpen,
    chapters,
    endingLine,
    endingStyle,
    trueFacts,
    narrativeWordCount,
  }
}

export function loadReferenceStory(file: string, dir: string = REFERENCE_DIR): ParsedReference {
  return parseReferenceStory(readFileSync(join(dir, file), 'utf8'))
}

/**
 * Shape a parsed reference into StoryOutput so it can go through the same deterministic
 * gate as a generated story (F7 VT).
 *
 * `true_facts` gets synthetic fact ids: the references predate fact packs, so there is
 * nothing real to map to. A caller checking the `unsourced_fact` rule must supply a
 * fact pack and remap; that limitation is deliberate and explicit rather than hidden
 * behind fabricated ids that look real.
 */
export function asStoryOutput(parsed: ParsedReference): StoryOutput {
  return {
    title: parsed.title,
    subtitle: parsed.subtitle,
    chapters: parsed.chapters.map((c) => ({
      heading: c.heading,
      text: c.text,
      shout_line: null,
    })),
    ending_line: parsed.endingLine ?? '',
    true_facts: parsed.trueFacts.map((text, i) => ({ text, fact_id: `f${i + 1}` })),
    bible_suggestions: { new_recurring: [], ending_summary: '' },
    estimated_read_minutes: Math.round(parsed.narrativeWordCount / 160),
  }
}
