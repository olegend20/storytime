import type { CallPurpose } from '@/lib/schemas/common'

/**
 * The Understudy workload each model call is tagged with (issue #76). The gateway picks a
 * request's workload from two headers; without them every call lands in the org's default
 * workload, `main`, and calls of every kind can only be looked at as one pile.
 *
 * One workload per `CallPurpose`, plus the continuation after a drop (#74): it is a `write`
 * call with its own prompt, so it is looked at on its own. Names are the gateway's, kebab-case.
 * `scripts/understudy-workloads.ts` registers exactly this list.
 */
export const WORKLOAD_FOR_PURPOSE = {
  write: 'write',
  rewrite: 'rewrite',
  normalize: 'normalize',
  classify_input: 'classify-input',
  quality: 'quality',
  safety_review: 'safety-review',
  mend: 'mend',
  repair: 'repair',
  bible_update: 'bible-update',
  factpack: 'factpack',
  factpack_review: 'factpack-review',
  judge_score: 'judge-score',
  judge_pairwise: 'judge-pairwise',
} as const satisfies Record<CallPurpose, string>

export const CONTINUATION_WORKLOAD = 'write-continue'

export type Workload = (typeof WORKLOAD_FOR_PURPOSE)[CallPurpose] | typeof CONTINUATION_WORKLOAD

/** Every workload, in the order the registration script creates them. */
export const WORKLOADS: readonly Workload[] = [
  ...Object.values(WORKLOAD_FOR_PURPOSE),
  CONTINUATION_WORKLOAD,
]

export function workloadFor(purpose: CallPurpose, opts: { continuation?: boolean } = {}): Workload {
  if (opts.continuation && purpose === 'write') return CONTINUATION_WORKLOAD
  return WORKLOAD_FOR_PURPOSE[purpose]
}

/** Evals run in `rehearsal` (the owner, 2026-10-21); production sets its own project. */
export const DEFAULT_UNDERSTUDY_PROJECT = 'rehearsal'

/**
 * Whether calls go through the Understudy gateway: only then are its headers sent.
 * `UNDERSTUDY_HEADERS=1` sends them to any base URL - the real-SDK tests' local server.
 */
export function viaUnderstudy(baseUrl: string | undefined = process.env.ANTHROPIC_BASE_URL): boolean {
  if (process.env.UNDERSTUDY_HEADERS === '1') return true
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname
    return host === 'understudylabs.com' || host.endsWith('.understudylabs.com')
  } catch {
    return false
  }
}

/** The request headers that tag a call with its workload, or none when not on the gateway. */
export function understudyHeaders(workload: Workload): Record<string, string> {
  if (!viaUnderstudy()) return {}
  return {
    'x-understudy-project': process.env.UNDERSTUDY_PROJECT || DEFAULT_UNDERSTUDY_PROJECT,
    'x-understudy-workload': workload,
  }
}

/**
 * The model that actually served a call, from the gateway's `x-understudy-effective-model`,
 * when it is not the one requested - a routed or fallback model must never be scored or saved
 * as the requested one. Null when they match or the header is absent (Anthropic directly).
 */
export function servedByOtherModel(requested: string, headers: Headers | null | undefined): string | null {
  const served = headers?.get('x-understudy-effective-model')?.trim()
  if (!served) return null
  // The gateway may prefix the supplier, e.g. `azure/claude-sonnet-5`.
  if (served === requested || served.endsWith(`/${requested}`)) return null
  return served
}
