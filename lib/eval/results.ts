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
  const candidates = resultPaths(prefix, opts)
  return candidates.length === 0 ? null : candidates[candidates.length - 1]!
}

/**
 * Every result file for a prefix, oldest first. Ordered by date, then by the same-day suffix:
 * a plain filename sort put `eval-2026-10-14.json` AFTER `eval-2026-10-14-2.json` ('-' sorts
 * before '.'), so the first run of a day was taken as the newest (issue #48 review).
 */
export function resultPaths(prefix: string, opts: { dir?: string; exclude?: string } = {}): string[] {
  const dir = opts.dir ?? RESULTS_DIR
  if (!existsSync(dir)) return []
  const key = (f: string): [string, number] => {
    const m = /^(.*?\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/.exec(f)
    return m ? [m[1]!, m[2] ? Number(m[2]) : 1] : [f, 1]
  }
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort((a, b) => {
      const [da, na] = key(a)
      const [db, nb] = key(b)
      return da < db ? -1 : da > db ? 1 : na - nb
    })
    .map((f) => join(dir, f))
    .filter((p) => p !== opts.exclude)
}

export function readResultFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
