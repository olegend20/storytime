import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Fixture record/replay. Kickoff rule 3: tests run against recorded fixtures by
 * default; live API calls only when LIVE_API=1.
 *
 * Record with:  LIVE_API=1 RECORD_FIXTURES=1 pnpm test
 * Replay with:  pnpm test        (the default)
 */

/** Fixtures recorded from real responses. Committed (kickoff rule 3). */
export const RECORDED_ROOT = join(process.cwd(), 'test', 'fixtures', 'model')

/**
 * Where a fixture is WRITTEN. `FIXTURE_DIR` lets the suite send test-fabricated payloads to a
 * temp directory so a hand-made response can never be mistaken for a recorded one.
 */
export const FIXTURE_ROOT = process.env.FIXTURE_DIR ?? RECORDED_ROOT

/**
 * Resolved PER CALL, not at module load.
 *
 * A test file that wants the committed fixtures deletes `FIXTURE_DIR` at its top; one that
 * fabricates payloads keeps the temp directory `test/setup.ts` provides. Reading the env once
 * at import time made that depend on module order, and a read-through fallback is worse: the
 * judge-fixture helper works by PROVOKING MissingFixtureError to learn the key it needs, so a
 * fallback that finds a recorded fixture instead breaks 38 tests. Exactly one directory is
 * live at a time, and the test file decides which.
 */
function fixtureRoot(): string {
  return process.env.FIXTURE_DIR ?? RECORDED_ROOT
}

export interface FixturePayload {
  /** Echoed for human readability when reviewing a diff; not part of the key. */
  purpose: string
  model: string
  response: unknown
  usage: {
    input_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    output_tokens: number
    web_searches?: number
  }
  stop_reason: string | null
  recorded_at: string
}

/**
 * Stable key over everything that changes the model's behaviour.
 * Deliberately excludes `purpose` so two call sites sending an identical request
 * share one fixture, and excludes nothing else - a prompt edit must miss the cache.
 */
export function fixtureKey(input: {
  model: string
  system?: unknown
  messages: unknown
  tools?: unknown
  max_tokens?: number
  output_config?: unknown
  thinking?: unknown
}): string {
  const canonical = stableStringify({
    model: input.model,
    system: input.system ?? null,
    messages: input.messages,
    tools: input.tools ?? null,
    max_tokens: input.max_tokens ?? null,
    output_config: input.output_config ?? null,
    thinking: input.thinking ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/** JSON.stringify with sorted object keys, so key order never churns fixtures. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

function fixturePath(purpose: string, key: string, root: string = fixtureRoot()): string {
  return join(root, purpose, `${key}.json`)
}

export function readFixture(purpose: string, key: string): FixturePayload | null {
  const path = fixturePath(purpose, key)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as FixturePayload
}

/** The directory a replay would search right now. */
export function fixtureReadRoots(): readonly string[] {
  return [fixtureRoot()]
}

export function writeFixture(purpose: string, key: string, payload: FixturePayload): string {
  const path = fixturePath(purpose, key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return path
}

export class MissingFixtureError extends Error {
  constructor(
    readonly purpose: string,
    readonly key: string,
    readonly model: string,
  ) {
    super(
      `No recorded fixture for purpose="${purpose}" model="${model}" key=${key}.\n` +
        `Expected at: ${fixturePath(purpose, key)}\n` +
        `Either the prompt changed (re-record) or this is a new call site.\n` +
        `Record it with:  LIVE_API=1 RECORD_FIXTURES=1 pnpm test\n` +
        `Tests never reach the live API without LIVE_API=1 (kickoff rule 3).`,
    )
    this.name = 'MissingFixtureError'
  }
}
