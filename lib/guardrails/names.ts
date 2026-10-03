/**
 * Comparing character names (issue #27). Rule 7's one exception is granted by name, so the
 * comparison has to be strict about what a name is: whole words, never substrings, so that
 * "Ann" never stands for "Anna" and "pup" never unlocks "Chase the pup". A name's first word
 * is its distinguishing one: "Max" does cover "Max Headroom", as "Sonic" covers "Sonic the
 * Hedgehog" - which means a composite blocklist entry ("Anna and Olaf") is waived by its
 * first name alone, so every such Y must also be listed on its own (Olaf is).
 */

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

/**
 * Whether a request names a listed character: the same key ("Spider-Man" / "Spiderman"), or
 * the request has the listed name's distinguishing word - its first - and the two names
 * are otherwise nested ("Sonic" / "Sonic the Hedgehog", "Mario and Luigi" / "Mario").
 * Words match whole or not at all, and a shared trailing word is not enough: "pup" names
 * neither "Chase the pup" nor "Marshall the pup".
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
  return tr.every((w) => listedHas.has(w)) || tl.every((w) => have.has(w))
}

/** Whether a piece of text names the character: one of its words, whole, case-insensitive. */
export function mentionsCharacter(text: string, name: string): boolean {
  const have = new Set(words(text))
  const tokens = nameTokens(name).filter((w) => w.length >= 3)
  return tokens.length > 0 && tokens.some((w) => have.has(w))
}

const MAX_NAME_WORDS = 4

/**
 * Keep only what the parent actually typed. The classifier extracts the names from the
 * topic, but what it returns is a model's list, and that list is what opens rule 7's
 * exception downstream - so code checks each one against the topic's own words, as runs:
 * "spider-man" and "Spider Man" both match "Spider-Man". A name the parent typed only the
 * start of ("Sonic" for the classifier's "Sonic the Hedgehog") is kept as the words they
 * typed. A name whose first word is not in the topic - from the child's likes, invented, or
 * "Captain America" on "the history of America" - is dropped.
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
    out.push(typed === own.length ? name.trim() : kept.map(capitalise).join(' '))
  }
  return out
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}
