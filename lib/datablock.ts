/**
 * Delimited data blocks. GUARDRAILS.md §3.4: all parent-provided text sits inside clearly
 * delimited blocks, never inside the instruction text, and every prompt that receives one
 * states that its contents are data rather than instructions.
 *
 * Shared by F4 (bible update), F5 (normalization, fact-pack review), F6 (generation) and
 * F7 (quality review) so there is one escaping rule, not four.
 */

/**
 * Neutralize anything that could close a block early or open a role tag. Parent text can
 * contain `<`, `>` and `&`; a topic is never legitimately allowed to contain markup, so
 * the safe move is to render it inert rather than to try to detect intent here (that is
 * L1/L2's job, which runs before this).
 */
export function escapeForDataBlock(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Zero-width and bidi control characters: invisible in review, meaningful to a model.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '')
}

/** `<tag>\n…\n</tag>`. `content` is inserted verbatim: escape parent text first. */
export function dataBlock(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`
}

/** A block whose content is parent-supplied free text. Always escaped. */
export function untrustedBlock(tag: string, text: string): string {
  return dataBlock(tag, escapeForDataBlock(text))
}

/** `<tag>value</tag>` on one line, for short scalar fields inside a request block. */
export function field(tag: string, value: string | number | null): string {
  if (value === null || value === '') return ''
  const rendered = typeof value === 'number' ? String(value) : escapeForDataBlock(value)
  return `<${tag}>${rendered}</${tag}>`
}
