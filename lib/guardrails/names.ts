/**
 * Comparing character names (issue #27). Rule 7's one exception is granted by name, so the
 * comparison has to be strict about what a name is: whole words, never substrings, so that
 * "Ann" never stands for "Anna" and "Max" never unlocks "Max Headroom".
 */

/** Letters and digits only, so "Spider-Man", "Spiderman" and "spider man" are one name. */
export function nameKey(name: string): string {
  return name.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
}

const STOP_WORDS = new Set(['the', 'and', 'of', 'a'])

/** The words of a name, lower-cased, without the connectives. */
export function nameTokens(name: string): string[] {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !STOP_WORDS.has(w))
}

/**
 * Two names are the same character when their keys are equal ("Spider-Man" / "Spiderman"),
 * or every word of one is a word of the other ("Sonic" / "Sonic the Hedgehog",
 * "Mario and Luigi" / "Mario"). Words match whole or not at all.
 */
export function sameCharacter(a: string, b: string): boolean {
  const ka = nameKey(a)
  const kb = nameKey(b)
  if (ka === '' || kb === '') return false
  if (ka === kb) return true
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  if (ta.length === 0 || tb.length === 0) return false
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const have = new Set(longer)
  return shorter.every((w) => have.has(w))
}

/**
 * Keep only the names that the parent actually typed. The classifier extracts them from the
 * topic, but what it returns is a model's list, and that list is what opens rule 7's
 * exception downstream - so code checks each one against the topic: the whole name
 * ("spiderman" in "spider-man teaches juno…"), or one of its words as a whole word of the
 * topic ("Sonic the Hedgehog" when the parent typed "Sonic"). A character the classifier
 * picked up from the child's likes, or invented, is dropped.
 */
export function namedInTopic(names: readonly string[], topic: string): string[] {
  const words = topic
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '')
  const topicWords = new Set(words)
  // Every run of up to four consecutive topic words, joined: "spider man" and "spider-man"
  // both become "spiderman", and "ann" is never found inside "anna".
  const runs = new Set<string>()
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) runs.add(words.slice(i, i + n).join(''))
  }
  return names.filter((name) => {
    const key = nameKey(name)
    const tokens = nameTokens(name)
    if (key === '' || tokens.length === 0) return false
    if (runs.has(key)) return true
    return tokens.some((w) => w.length >= 3 && topicWords.has(w))
  })
}
