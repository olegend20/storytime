import type { CallPurpose } from '@/lib/schemas/common'

/**
 * The Understudy workload each model call is tagged with (issue #76). The gateway picks a
 * request's workload from two headers; without them every call lands in the org's default
 * workload, `main`, and calls of every kind can only be looked at as one pile.
 *
 * One workload per `CallPurpose`, plus two writing calls that are not what their purpose
 * usually is, so they are looked at on their own (the code review on #77): the continuation
 * after a drop (#74), a `write` with its own prompt, and the shorter retry of an unusable first
 * write (#32 rung 3), a `rewrite` call that sends the first-write prompt. Kebab-case names.
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

export const VARIANT_WORKLOADS = {
  continuation: { purpose: 'write', workload: 'write-continue' },
  shorter: { purpose: 'rewrite', workload: 'write-shorter' },
} as const satisfies Record<string, { purpose: CallPurpose; workload: string }>

export type WorkloadVariant = keyof typeof VARIANT_WORKLOADS

export type Workload =
  | (typeof WORKLOAD_FOR_PURPOSE)[CallPurpose]
  | (typeof VARIANT_WORKLOADS)[WorkloadVariant]['workload']

/** Every workload, in the order the registration script creates them. */
export const WORKLOADS: readonly Workload[] = [
  ...Object.values(WORKLOAD_FOR_PURPOSE),
  ...Object.values(VARIANT_WORKLOADS).map((v) => v.workload),
]

/** A variant only applies to the purpose it belongs to; anything else keeps its purpose's. */
export function workloadFor(purpose: CallPurpose, variant?: WorkloadVariant): Workload {
  const v = variant ? VARIANT_WORKLOADS[variant] : undefined
  return v && v.purpose === purpose ? v.workload : WORKLOAD_FOR_PURPOSE[purpose]
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
  return sameModel(requested, served) ? null : served
}

/**
 * One model under two ids: a supplier prefix (`azure/claude-sonnet-5`) and a dated snapshot
 * against its alias (`claude-haiku-4-5-20251001` / `claude-haiku-4-5`) are the same model.
 */
function sameModel(a: string, b: string): boolean {
  const base = (id: string) => id.toLowerCase().replace(/^.*\//, '').replace(/-\d{8}$/, '')
  return base(a) === base(b)
}
