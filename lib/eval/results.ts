import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `eval/results/` - the run archive. F13: "stores results in eval/results/<date>.json and
 * prints a comparison against the previous run"; JUDGE_AGENT.md §5: "log the calibration
 * result in eval/results/calibration-<date>.json"; §6: the bake-off writes both a JSON and
 * a markdown report.
 *
 * Files are named by date and never overwritten silently: a second run on the same day
 * gets a `-2` suffix, because a run that quietly replaced yesterday's numbers would make
 * the before/after comparison a lie.
 */

export const RESULTS_DIR = join(process.cwd(), 'eval', 'results')

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function ensureResultsDir(dir: string = RESULTS_DIR): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** `<prefix><date>.json`, or `<prefix><date>-2.json` if that exists, and so on. */
export function nextResultPath(
  prefix: string,
  extension: 'json' | 'md',
  opts: { dir?: string; date?: string } = {},
): string {
  const dir = ensureResultsDir(opts.dir ?? RESULTS_DIR)
  const date = opts.date ?? today()
  let path = join(dir, `${prefix}${date}.${extension}`)
  let n = 2
  while (existsSync(path)) {
    path = join(dir, `${prefix}${date}-${n}.${extension}`)
    n += 1
  }
  return path
}

export function writeResultFile(path: string, contents: unknown): string {
  const text =
    typeof contents === 'string' ? contents : `${JSON.stringify(contents, null, 2)}\n`
  writeFileSync(path, text, 'utf8')
  return path
}

/**
 * The most recent result file matching a prefix, excluding `exclude` (the one just
 * written). Sorted by filename, which sorts by date because the names are ISO dates.
 */
export function previousResultPath(
  prefix: string,
  opts: { dir?: string; exclude?: string } = {},
): string | null {
  const dir = opts.dir ?? RESULTS_DIR
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => join(dir, f))
    .filter((p) => p !== opts.exclude)
    .sort()
  return candidates.length === 0 ? null : candidates[candidates.length - 1]!
}

export function readResultFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
