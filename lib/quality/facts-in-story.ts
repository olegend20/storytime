import type { StoryOutput } from '@/lib/schemas'

/**
 * "Every bold term in the True Facts list is a term the story used" (config/bands.json),
 * checked by code.
 *
 * The list is where the owner's first story was marked down: the writer copied the fact
 * pack's adult wording into it - "Mid-Atlantic Ridge" - for a fact the story had told in a
 * child's words ("two of Earth's giant plates are slowly pulling apart"). Whether a
 * term appears in the story is not a judgement call, so it is not left to a model.
 *
 * It looks for terms that are FOREIGN to the story, not for paraphrase. Matching is on
 * words, and loosely: "**pull-along duck**" is fine in a story where Cruz "pulled the wooden
 * duck" (the owner's LEGO reference does exactly this), "**4,000 meters**" matches "4000
 * meters high". A term is missing only when most of its words appear nowhere in the story.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'and', 'or', 'by', 'for', 'from', 'with',
  'about', 'over', 'than', 'its', 'is', 'was', 'as',
])

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(\d)[,](?=\d)/g, '$1')
    .replace(/[’']s\b/g, '')
    .split(/[^\p{L}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t !== '' && !STOPWORDS.has(t))
    .map(stem)
}

/** Enough to match a plural to its singular. Not a linguistic stemmer, and not meant to be. */
function stem(word: string): string {
  if (/\d/.test(word) || word.length <= 3) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.endsWith('es') && /(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/**
 * Exact, or the same word inflected: "pull" matches "pulled", "erupt" "eruption". The length
 * gap is capped so a compound is not found through its prefix - a story that says "super
 * hot" has not thereby said "supervolcano".
 */
function inStory(word: string, narrative: ReadonlySet<string>): boolean {
  if (narrative.has(word)) return true
  if (word.length < 4 || /\d/.test(word)) return false
  for (const t of narrative) {
    if (t.length < 4 || Math.abs(t.length - word.length) > 3) continue
    if (t.startsWith(word) || word.startsWith(t)) return true
  }
  return false
}

export function boldTerms(text: string): string[] {
  return [...text.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]!.trim()).filter((t) => t !== '')
}

export interface MissingFactTerm {
  index: number
  fact_id: string
  term: string
}

/** Bold terms in the True Facts list that the narrative never used. */
export function factTermsMissingFromStory(
  story: Pick<StoryOutput, 'chapters' | 'ending_line' | 'true_facts'>,
): MissingFactTerm[] {
  const narrative = new Set(
    tokens([...story.chapters.map((c) => `${c.heading}\n${c.text}`), story.ending_line].join('\n')),
  )
  const missing: MissingFactTerm[] = []
  for (const [index, item] of story.true_facts.entries()) {
    for (const term of boldTerms(item.text)) {
      const words = tokens(term)
      if (words.length === 0) continue
      const found = words.filter((w) => inStory(w, narrative)).length
      if (found * 2 < words.length || (words.length === 1 && found === 0)) {
        missing.push({ index, fact_id: item.fact_id, term })
      }
    }
  }
  return missing
}
