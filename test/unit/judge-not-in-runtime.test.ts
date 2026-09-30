import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * THE JUDGE MUST NEVER RUN IN THE NIGHTLY GENERATION PATH.
 *
 * JUDGE_AGENT.md §1: "it never runs in the nightly generation path (the cheap Quality Gate
 * in F7 does that). It runs in `pnpm eval` and `pnpm bakeoff`."
 *
 * This is a COST control as much as a design one. The judge is Fable 5.1 or Opus 5.5 reading
 * a whole story: roughly $0.13 per call against ~$0.07 for the entire story that produced it.
 * Wiring it into the per-story path would more than double the cost of every bedtime story
 * and buy a parent nothing, because the F7 gate already protects them.
 *
 * The failure mode this guards is quiet: an import added for a type, then used for a call.
 * So the assertion is on the import graph, not on intent.
 */

const RUNTIME_ROOTS = ['app', 'lib/generate', 'lib/quality', 'lib/bible', 'lib/topics', 'lib/guardrails', 'lib/limits', 'lib/costs', 'lib/children', 'lib/family', 'lib/http', 'lib/admin']

/** Modules only the eval harness may touch. */
const EVAL_ONLY = ['lib/eval', 'eval/']

function sourceFiles(root: string): string[] {
  const abs = join(process.cwd(), root)
  let entries: string[]
  try {
    entries = readdirSync(abs)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const full = join(abs, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(join(root, entry)))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(join(root, entry))
    }
  }
  return out
}

const runtimeFiles = RUNTIME_ROOTS.flatMap(sourceFiles)

describe('the judge is confined to the eval harness', () => {
  it('finds runtime source to check', () => {
    expect(runtimeFiles.length).toBeGreaterThan(20)
  })

  it('no runtime module imports the eval harness', () => {
    const offenders: string[] = []
    for (const file of runtimeFiles) {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      for (const evalPath of EVAL_ONLY) {
        if (src.includes(`@/${evalPath}`) || src.includes(`from '${evalPath}`)) {
          offenders.push(`${file} imports ${evalPath}`)
        }
      }
    }
    expect(
      offenders,
      `The judge and the eval harness must not be reachable from the request path:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  it('no runtime module resolves a judge model', () => {
    const offenders: string[] = []
    for (const file of runtimeFiles) {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      if (/judge_primary|judge_secondary/.test(src)) offenders.push(file)
    }
    expect(offenders, `judge model roles referenced in the request path:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('no runtime module logs a judge purpose', () => {
    const offenders: string[] = []
    for (const file of runtimeFiles) {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      if (/judge_score|judge_pairwise/.test(src)) offenders.push(file)
    }
    expect(offenders, `judge call purposes in the request path:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  /**
   * The positive half: the per-story quality check must be the CHEAP model. If this ever
   * points at a judge-tier model, every story silently gets dearer.
   */
  it('the per-story quality gate runs on the helper model, not a judge model', () => {
    const gate = sourceFiles('lib/quality')
      .map((f) => readFileSync(join(process.cwd(), f), 'utf8'))
      .join('\n')
    expect(gate.length).toBeGreaterThan(0)
    // Not the writing model, and not a judge role or purpose. Deliberately matched on code
    // shapes rather than the word "judge": the gate's comments legitimately contain English
    // like "the real judgement is the review", and a regex that flags prose gets deleted by
    // the next person it annoys, which is worse than no check at all.
    expect(gate).not.toMatch(/role: 'writer'/)
    expect(gate).not.toMatch(/judge_primary|judge_secondary|judge_score|judge_pairwise/)
    expect(gate).not.toMatch(/from '@\/lib\/eval/)
    // It must name the helper role, i.e. Haiku resolved through config/models.json.
    expect(/role: 'helper'|modelForRole\('helper'\)/.test(gate),
      'the quality gate should call the helper model').toBe(true)
  })
})

describe('the runtime path never names a model id literally', () => {
  it('model ids come from config/models.json, not from source', () => {
    const offenders: string[] = []
    for (const file of runtimeFiles) {
      const src = readFileSync(join(process.cwd(), file), 'utf8')
      // Allow a comment mentioning a model; flag a string literal.
      const matches = src.match(/['"`]claude-[a-z0-9.-]+['"`]/g) ?? []
      if (matches.length > 0) offenders.push(`${relative('.', file)}: ${matches.join(', ')}`)
    }
    expect(
      offenders,
      `Kickoff rule 2 - model ids are config, never hard-coded:\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })
})
