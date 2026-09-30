/**
 * Generates `lib/mock/fixture-stories.json` - the library/reader/SSE fixture set for
 * lane 4's mock API (F9/F10). Run with `pnpm fixtures:ui`.
 *
 * Content comes from `storytime-plan/reference-stories/` via `lib/reference.ts`, so the
 * reader is designed and tested against real story prose (cold open, 7-10 chapters, sound
 * words in caps, bolded facts, ending line, 8-14 true facts) rather than lorem ipsum.
 *
 * The output is committed so route handlers never touch `storytime-plan/` at runtime -
 * `next.config.ts` deliberately keeps that directory out of the build graph.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  asStoryOutput,
  loadManifest,
  loadReferenceStory,
  type ReferenceEntry,
} from '@/lib/reference'
import {
  STORY_MAX_CHAPTERS,
  StoryOutput,
  Tone,
  bandForAge,
  storyWordCount,
  targetWords,
} from '@/lib/schemas'

/**
 * DECISIONS.md #25: two references head their return-home coda, so `parseReferenceStory`
 * reports up to 12 sections while `StoryOutput` caps `chapters` at 10. The SSE `done` event
 * carries a real `StoryOutput`, so a fixture that cannot satisfy the schema would be
 * testing the wrong thing. Fold the trailing coda into the chapter before it: every word of
 * prose is kept, and the fixture is a valid `StoryOutput`.
 */
function foldCoda(story: StoryOutput): StoryOutput {
  const chapters = [...story.chapters]
  while (chapters.length > STORY_MAX_CHAPTERS) {
    const coda = chapters.pop()
    const prev = chapters[chapters.length - 1]
    if (!coda || !prev) break
    chapters[chapters.length - 1] = { ...prev, text: `${prev.text}\n\n${coda.text}` }
  }
  return { ...story, chapters }
}

/** Deterministic uuids so fixture ids are stable across regenerations. */
function fixtureUuid(seed: string, n: number): string {
  let h = 0x811c9dc5
  for (const ch of seed) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const hex = (h.toString(16) + n.toString(16).padStart(4, '0')).padStart(12, '0').slice(-12)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-8000-${hex}`
}

const FAMILY_ID = fixtureUuid('family', 1)

/** The manifest records free-text tones ("fun"); map them onto the Tone enum. */
function toTones(raw: readonly string[]): Tone[] {
  const mapped: Tone[] = []
  for (const t of raw) {
    const candidate = t === 'fun' ? 'funny' : t
    const parsed = Tone.safeParse(candidate)
    if (parsed.success && !mapped.includes(parsed.data)) mapped.push(parsed.data)
  }
  if (mapped.length === 0) mapped.push('funny')
  return mapped.slice(0, 2)
}

function childNames(entry: ReferenceEntry): string[] {
  return entry.request.children.map((c) => c.name)
}

/** Newest first in the library; older stories get earlier timestamps. */
const BASE_TIME = Date.parse('2026-09-20T19:30:00.000Z')

function build() {
  const manifest = loadManifest()
  const seriesIds = new Map<string, string>()
  const stories = manifest.stories.map((entry, i) => {
    const parsed = loadReferenceStory(entry.file)
    const content = StoryOutput.parse(foldCoda(asStoryOutput(parsed)))
    const band = bandForAge(entry.request.youngest_age)
    let seriesId = seriesIds.get(entry.series)
    if (!seriesId) {
      seriesId = fixtureUuid(`series:${entry.series}`, 1)
      seriesIds.set(entry.series, seriesId)
    }
    const names = childNames(entry)
    return {
      id: fixtureUuid(`story:${entry.file}`, i),
      family_id: FAMILY_ID,
      series_id: seriesId,
      series_key: entry.series,
      series_title: `${names.join(' & ')}`,
      sequence: entry.sequence,
      child_names: names,
      topic_input: entry.request.topic_input,
      topic_key: entry.request.topic_key,
      topic_label: parsed.subtitle ?? entry.request.topic_input,
      fact_pack_id: null,
      tones: toTones(entry.request.tones),
      length_minutes: entry.request.length_minutes,
      age_band: band,
      title: content.title,
      content,
      word_count: storyWordCount(content),
      status: 'ready' as const,
      created_at: new Date(BASE_TIME + i * 86_400_000).toISOString(),
      target_words: targetWords({ band, minutes: entry.request.length_minutes }),
    }
  })

  const outDir = join(process.cwd(), 'lib', 'mock')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, 'fixture-stories.json'),
    JSON.stringify({ family_id: FAMILY_ID, stories }, null, 2) + '\n',
    'utf8',
  )
  for (const s of stories) {
    console.log(
      `${s.id}  ${s.age_band}  ${String(s.word_count).padStart(5)}w  ` +
        `${s.content.chapters.length}ch ${s.content.true_facts.length}f  ${s.title}`,
    )
  }
  console.log(`\nWrote ${stories.length} fixture stories to lib/mock/fixture-stories.json`)
}

build()
