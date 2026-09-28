import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Prompt loader. CLAUDE.md rule 5: prompts live in `prompts/*.md` with a version header.
 *
 * Files are named `<id>.v<N>.md` and carry a front-matter block:
 *
 *   ---
 *   id: master
 *   version: 1
 *   purpose: ...
 *   ---
 *   <the prompt body>
 *
 * `loadPrompt('master')` picks the highest version on disk, so bumping a prompt is a new
 * file rather than an edit to a deployed one, and the version in the front matter must
 * agree with the filename (a mismatch throws rather than silently loading the wrong text).
 *
 * The BODY is what goes to the model. The front matter is stripped, so metadata edits
 * cannot change the cached master block's bytes - but a body edit changes them, which is
 * exactly the cache miss that CLAUDE.md rule 5 asks us to notice and re-eval.
 *
 * Node-only (fs). Imported from server code, tests and eval/ - never a browser bundle.
 */

export const PROMPT_DIR = join(process.cwd(), 'prompts')

export interface LoadedPrompt {
  id: string
  version: number
  /** The prompt text itself, front matter stripped, trailing newline trimmed. */
  body: string
  file: string
  meta: Record<string, string>
}

const cache = new Map<string, LoadedPrompt>()

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = FRONT_MATTER.exec(raw)
  if (!match) return { meta: {}, body: raw.trim() }
  const meta: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { meta, body: raw.slice(match[0].length).trim() }
}

/** Every `<id>.v<N>.md` on disk for this id, newest version first. */
export function promptVersions(id: string, dir: string = PROMPT_DIR): number[] {
  if (!existsSync(dir)) return []
  const pattern = new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.v(\\d+)\\.md$`)
  return readdirSync(dir)
    .map((f) => pattern.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a)
}

export function loadPrompt(id: string, dir: string = PROMPT_DIR): LoadedPrompt {
  const cacheKey = `${dir}::${id}`
  const hit = cache.get(cacheKey)
  if (hit) return hit

  const versions = promptVersions(id, dir)
  if (versions.length === 0) {
    throw new Error(
      `No prompt file for "${id}". Expected ${join(dir, `${id}.v1.md`)}. ` +
        `Prompts live in prompts/*.md with a version header (CLAUDE.md rule 5).`,
    )
  }
  const version = versions[0]!
  const file = join(dir, `${id}.v${version}.md`)
  const { meta, body } = parseFrontMatter(readFileSync(file, 'utf8'))

  if (meta.version !== undefined && Number(meta.version) !== version) {
    throw new Error(
      `${file}: front matter says version ${meta.version} but the filename says v${version}.`,
    )
  }
  if (meta.id !== undefined && meta.id !== id) {
    throw new Error(`${file}: front matter id "${meta.id}" does not match "${id}".`)
  }
  if (body.length === 0) throw new Error(`${file} has no prompt body.`)

  const loaded: LoadedPrompt = { id, version, body, file, meta }
  cache.set(cacheKey, loaded)
  return loaded
}

/** Tests that write prompt files to a temp dir call this between cases. */
export function resetPromptCache(): void {
  cache.clear()
}

/**
 * Rough token estimate. We deliberately do NOT call the count_tokens endpoint here:
 * the bible size check runs on every load and must be free and synchronous.
 *
 * Calibrated to over-estimate slightly on JSON (punctuation-dense text tokenizes worse
 * than prose), so a bible that passes the <=800 check locally cannot exceed it on the
 * wire. Both terms matter: char/3.6 dominates for JSON, words*1.35 for plain prose.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  const words = text.trim().split(/\s+/).length
  return Math.max(Math.ceil(text.length / 3.6), Math.ceil(words * 1.35))
}
