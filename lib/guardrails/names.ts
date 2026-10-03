/**
 * Comparing character names (issue #27). Rule 7's one exception is granted by name, so the
 * comparison has to be strict about what a name is: whole words, never substrings, so that
 * "Ann" never stands for "Anna" and "pup" never unlocks "Chase the pup". A name's first word
 * is its distinguishing one: "Sonic" covers "Sonic the
 * Hedgehog", when that first word is a listed character on its own - which means a composite
 * blocklist entry ("Anna and Olaf") is waived by its first name alone, so every such Y must
 * also be listed on its own (Olaf is).
 */

import { blocklist } from './blocklist'

/** Lower-case words of letters and digits. NFKD then the marks dropped, so "Pokémon" is one word. */
function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '')
}

/** Letters and digits only, so "Spider-Man", "Spiderman" and "spider man" are one name. */
export function nameKey(name: string): string {
  return words(name).join('')
}

const STOP_WORDS = new Set(['the', 'and', 'of', 'a'])

/** The words of a name, lower-cased, without the connectives. */
export function nameTokens(name: string): string[] {
  return words(name).filter((w) => !STOP_WORDS.has(w))
}

/** The keys of every franchise name the output scan knows. */
const KNOWN_CHARACTER_KEYS = new Set((blocklist.output.franchise_characters ?? []).map(nameKey))

/** Whether a name, on its own, is one the output scan lists ("Sonic" is; "Princess" is not). */
export function isKnownCharacter(name: string): boolean {
  return KNOWN_CHARACTER_KEYS.has(nameKey(name))
}

/**
 * Whether a request names a listed character: the same key ("Spider-Man" / "Spiderman"), or
 * the request has the listed name's distinguishing word - its first - and the two names
 * are otherwise nested ("Sonic" / "Sonic the Hedgehog", "Mario and Luigi" / "Mario").
 * Words match whole or not at all, and a shared trailing word is not enough: "pup" names
 * neither "Chase the pup" nor "Marshall the pup". A request SHORTER than the listed name
 * covers it only if the request is itself a listed character: "Sonic" is, so it covers the
 * long form; "Princess" is not, so it covers neither Peach nor Leia.
 */
export function requestCovers(requested: string, listed: string): boolean {
  const kr = nameKey(requested)
  const kl = nameKey(listed)
  if (kr === '' || kl === '') return false
  if (kr === kl) return true
  const tr = nameTokens(requested)
  const tl = nameTokens(listed)
  if (tr.length === 0 || tl.length === 0) return false
  const have = new Set(tr)
  if (!have.has(tl[0]!)) return false
  const listedHas = new Set(tl)
  if (tr.every((w) => listedHas.has(w))) return tr.length >= tl.length || KNOWN_CHARACTER_KEYS.has(kr)
  return tl.every((w) => have.has(w))
}

/**
 * Whether a piece of text names the character: all of its words, whole, case-insensitive,
 * or the name run together. "Spider-Man" is in "Spider-Man waved" and "spiderman's web",
 * not in "the old man at the lighthouse".
 */
export function mentionsCharacter(text: string, name: string): boolean {
  const textWords = words(text)
  const have = new Set(textWords)
  const tokens = nameTokens(name)
  if (tokens.length === 0) return false
  if (tokens.every((w) => have.has(w))) return true
  const key = nameKey(name)
  return key.length >= 3 && textWords.some((w) => w === key)
}

const MAX_NAME_WORDS = 4

/**
 * Keep only what the parent actually typed. The classifier extracts the names from the
 * topic, but what it returns is a model's list, and that list is what opens rule 7's
 * exception downstream - so code checks each one against the topic's own words, as runs:
 * "spider-man" and "Spider Man" both match "Spider-Man". A name the parent typed only the
 * start of ("Sonic" for the classifier's "Sonic the Hedgehog") is kept as the words they
 * typed. A name whose first word is not in the topic - from the child's likes, invented, or
 * "Captain America" on "the history of America" - is dropped, and so is one the parent typed
 * only a generic start of.
 */
export function namedInTopic(names: readonly string[], topic: string): string[] {
  const topicWords = words(topic)
  const runs = new Set<string>()
  for (let i = 0; i < topicWords.length; i++) {
    for (let n = 1; n <= MAX_NAME_WORDS && i + n <= topicWords.length; n++) {
      runs.add(topicWords.slice(i, i + n).join(''))
    }
  }
  const out: string[] = []
  for (const name of names) {
    const own = words(name)
    if (own.length === 0 || nameTokens(name).length === 0) continue
    // The longest run of the name's leading words that the parent typed, if any.
    // Compared joined, so "Spider-Man", "Spider Man" and "spiderman" are the same run.
    let typed = 0
    for (let n = own.length; n >= 1; n--) {
      if (runs.has(own.slice(0, n).join(''))) {
        typed = n
        break
      }
    }
    // A trailing connective ("Sonic the"), a lone one, or a two-letter fragment is not a name.
    while (typed > 0 && STOP_WORDS.has(own[typed - 1]!)) typed--
    if (typed === 0) continue
    const kept = own.slice(0, typed)
    if (kept.join('').length < 3) continue
    if (typed === own.length) {
      out.push(name.trim())
      continue
    }
    // Only part of the name was typed. That part stands on its own only when it is a
    // character in its own right ("Sonic" for "Sonic the Hedgehog"); a generic start
    // ("Princess" for "Princess Peach", "Captain", "Iron") names nobody and is dropped.
    const typedName = kept.map(capitalise).join(' ')
    if (isKnownCharacter(typedName)) out.push(typedName)
  }
  return out
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
