import { LengthMinutes } from '@/lib/schemas'
import { z } from 'zod'
import { readRaw, removeRaw, writeRaw } from './localStore'

/**
 * Everything the app remembers on the device, and nothing more:
 *  - reading preferences (theme, reading mode, text size),
 *  - the last-used children and length, so the nightly form is pre-filled (F10 AC),
 *  - scroll position and ticked facts, per story (F9 AC).
 *
 * All of it goes through `localStore`, so a change made in one component re-renders the others
 * that read the same key, and nothing needs an effect to notice. None of it leaves the device -
 * F11 forbids third-party analytics on children's data, and this is the same principle applied to
 * behaviour: what a parent reads is their business.
 */

const NS = 'storytime:v1'

/** Parse a raw stored string against a schema; anything unexpected yields `fallback`. */
export function parseStored<T>(raw: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (raw === null) return fallback
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

export function readJson<T>(key: string, schema: z.ZodType<T>, fallback: T): T {
  return parseStored(readRaw(key), schema, fallback)
}

export function writeJson(key: string, value: unknown): void {
  try {
    writeRaw(key, JSON.stringify(value))
  } catch {
    /* a value that cannot be serialized is a bug, not a user-visible failure */
  }
}

// ------------------------------------------------------------------ reading preferences
export const Theme = z.enum(['system', 'light', 'dark', 'night'])
export type Theme = z.infer<typeof Theme>

/** Step multipliers for the reader's text-size control. 1 = the comfortable default. */
export const TEXT_SCALES = [0.9, 1, 1.15, 1.35, 1.6] as const
export const DEFAULT_TEXT_SCALE_INDEX = 1

export const ReadingPrefs = z.object({
  theme: Theme.default('system'),
  readingMode: z.boolean().default(false),
  textScaleIndex: z
    .number()
    .int()
    .min(0)
    .max(TEXT_SCALES.length - 1)
    .default(DEFAULT_TEXT_SCALE_INDEX),
})
export type ReadingPrefs = z.infer<typeof ReadingPrefs>

export const DEFAULT_READING_PREFS: ReadingPrefs = {
  theme: 'system',
  readingMode: false,
  textScaleIndex: DEFAULT_TEXT_SCALE_INDEX,
}

export const PREFS_KEY = `${NS}:prefs`

export function loadReadingPrefs(): ReadingPrefs {
  return readJson(PREFS_KEY, ReadingPrefs, DEFAULT_READING_PREFS)
}

export function saveReadingPrefs(prefs: ReadingPrefs): void {
  writeJson(PREFS_KEY, prefs)
}

// ------------------------------------------------------------------ F10: remembered form
export const StoryFormMemory = z.object({
  childIds: z.array(z.string()).default([]),
  lengthMinutes: LengthMinutes.default(10),
})
export type StoryFormMemory = z.infer<typeof StoryFormMemory>

/** §0: "Story length - parent picks 5 / 10 / 15. Default 10." */
export const DEFAULT_FORM_MEMORY: StoryFormMemory = { childIds: [], lengthMinutes: 10 }

export const FORM_KEY = `${NS}:form`

export function loadFormMemory(): StoryFormMemory {
  return readJson(FORM_KEY, StoryFormMemory, DEFAULT_FORM_MEMORY)
}

export function saveFormMemory(memory: StoryFormMemory): void {
  writeJson(FORM_KEY, memory)
}

// ------------------------------------------------------------------ F9: scroll per story
export const ScrollMemory = z.object({ y: z.number().nonnegative(), savedAt: z.string() })
export type ScrollMemory = z.infer<typeof ScrollMemory>

export function scrollKey(storyId: string): string {
  return `${NS}:scroll:${storyId}`
}

export const NullableScrollMemory = ScrollMemory.nullable()

export function loadScroll(storyId: string): ScrollMemory | null {
  return readJson<ScrollMemory | null>(scrollKey(storyId), NullableScrollMemory, null)
}

export function saveScroll(storyId: string, y: number): void {
  // Round-tripping the exact pixel is pointless; the AC is "within 200px".
  writeJson(scrollKey(storyId), { y: Math.round(y), savedAt: new Date().toISOString() })
}

export function clearScroll(storyId: string): void {
  removeRaw(scrollKey(storyId))
}

// ------------------------------------------------------------------ F9: facts checklist
export const CheckedFacts = z.array(z.number().int().nonnegative())

export function factsKey(storyId: string): string {
  return `${NS}:facts:${storyId}`
}

export const NO_FACTS: readonly number[] = []

export function loadCheckedFacts(storyId: string): number[] {
  return readJson(factsKey(storyId), CheckedFacts, [])
}

export function saveCheckedFacts(storyId: string, checked: readonly number[]): void {
  writeJson(factsKey(storyId), [...checked].sort((a, b) => a - b))
}

export function clearCheckedFacts(storyId: string): void {
  removeRaw(factsKey(storyId))
}

/** Called after a delete, so a removed story leaves nothing behind on the device. */
export function forgetStory(storyId: string): void {
  clearScroll(storyId)
  clearCheckedFacts(storyId)
}
