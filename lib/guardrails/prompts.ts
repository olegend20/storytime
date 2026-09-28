import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Prompt loader. CLAUDE.md rule 5: "Prompts live in prompts/*.md with a version header."
 *
 * A prompt file is authored as a document (headers, rationale, the output contract) and
 * the parts the model sees are marked with `## System prompt` / `## Output` /
 * `## User message` sections. This extracts them so the .md stays readable and reviewable
 * while the bytes sent to the model are exact and stable (prompt caching is a prefix
 * match - see DECISIONS.md).
 */

export const PROMPT_DIR = join(process.cwd(), 'prompts')

const cache = new Map<string, string>()

export function readPromptFile(name: string): string {
  let text = cache.get(name)
  if (text === undefined) {
    text = readFileSync(join(PROMPT_DIR, name), 'utf8')
    cache.set(name, text)
  }
  return text
}

/** Pull one `## <heading>` section out of a prompt document, without its heading. */
export function promptSection(name: string, heading: string): string {
  const text = readPromptFile(name)
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im')
  const start = re.exec(text)
  if (!start) throw new Error(`prompt "${name}" has no "## ${heading}" section`)
  const from = start.index + start[0].length
  const rest = text.slice(from)
  const next = /^##\s+/m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

/** Version from the `- version: N` line in the header. Logged with every call. */
export function promptVersion(name: string): number {
  const m = /^-\s*version:\s*(\d+)\s*$/im.exec(readPromptFile(name))
  if (!m) throw new Error(`prompt "${name}" has no version header`)
  return Number(m[1])
}

export const INPUT_CLASSIFIER_PROMPT = 'guardrail.input-classifier.v1.md'
export const OUTPUT_REVIEW_PROMPT = 'guardrail.output-review.v1.md'
