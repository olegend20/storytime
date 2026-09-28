/**
 * The small slice of markdown that story prose actually uses.
 *
 * Reading `storytime-plan/reference-stories/`: paragraphs separated by blank lines, `**bold**`
 * for the facts a child should catch and for sound words in caps, `*italic*` for the closing
 * bedtime line and foreign phrases, and `***both***` for a term being introduced
 * (***leg godt***). Nothing else - no links, no images, no tables.
 *
 * Tokenizing to a data structure rather than to HTML is deliberate: the renderer builds React
 * elements, so no story text is ever handed to `dangerouslySetInnerHTML`. A story is model
 * output with parent-supplied names inside it; it does not get to inject markup.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'strong'; text: string; sound: boolean }
  | { kind: 'strongEm'; text: string; sound: boolean }

/**
 * Sound words get their own styling - they are the bit a 4-year-old shouts along with.
 *
 * All-caps alone is too broad (**LEGO**, **BILLUND, DENMARK.** are bold caps but not sounds),
 * so a sound word must also either end in an exclamation mark or stretch a letter:
 * WHOOOOSH, HISSSS, CLICK!, "CLUNK. HISSSS. POP!". Getting this wrong only changes emphasis,
 * never meaning.
 */
export function isSoundWord(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 40) return false
  const letters = trimmed.replace(/[^\p{L}]/gu, '')
  if (letters.length < 4) return false
  if (letters !== letters.toUpperCase()) return false
  if (/\p{Ll}/u.test(trimmed)) return false
  return trimmed.endsWith('!') || /(\p{L})\1\1/u.test(trimmed)
}

/** `***x***` | `**x**` | `*x*`, non-greedy, no nesting. */
const INLINE = /(\*\*\*)([^*]+?)\1|(\*\*)([^*]+?)\3|(\*)([^*]+?)\5/g

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const at = m.index
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    const strongEm = m[2]
    const strong = m[4]
    const em = m[6]
    if (strongEm !== undefined) {
      out.push({ kind: 'strongEm', text: strongEm, sound: isSoundWord(strongEm) })
    } else if (strong !== undefined) {
      out.push({ kind: 'strong', text: strong, sound: isSoundWord(strong) })
    } else if (em !== undefined) {
      out.push({ kind: 'em', text: em })
    }
    last = at + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/**
 * Split prose into paragraphs and tokenize each one.
 *
 * A single newline inside a paragraph becomes a space: the model wraps lines, and honouring
 * soft wraps would put a line break in the middle of a sentence on a 375px phone. A `---`
 * rule on its own line is a section divider in the source and is dropped.
 */
export function parseParagraphs(text: string): Inline[][] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && !/^-{3,}$/.test(p))
    .map((p) => parseInline(p.replace(/\n/g, ' ')))
}

/** Plain text of a token run - for aria labels and word counts. */
export function inlineText(tokens: readonly Inline[]): string {
  return tokens.map((t) => t.text).join('')
}
