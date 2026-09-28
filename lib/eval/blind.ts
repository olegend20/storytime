import { models } from '@/lib/ai/pricing'

/**
 * Blindness enforcement - JUDGE_AGENT.md §2 ("the judge never sees which model wrote a
 * story, the cost, or the model name") and the §7 VT:
 *
 *   "assert the judge prompt payload contains none of the contestant model IDs or the
 *    string 'opus'/'sonnet'/'haiku' outside the rubric text."
 *
 * This is the single assertion that makes the bake-off worth running. If the judge can
 * tell which contestant wrote a story, every pairwise verdict is contaminated and the
 * whole exercise measures brand recognition. So the check runs on the assembled payload
 * of EVERY judge call in normal operation, not only in tests, and it throws rather than
 * warns.
 */

/**
 * Brand words that would identify a contestant even without a full model id. Matched
 * case-insensitively as substrings, exactly as the VT words it.
 *
 * KNOWN FALSE-POSITIVE RISK, stated rather than silently worked around: these are also
 * ordinary English words or fragments of them. "fable"/"fables" is the obvious one for a
 * children's-story product, and "affable" contains it. A story about Aesop, or about
 * Japanese poetry (for "haiku"), would trip this check and fail the run.
 *
 * That is the right failure. A leak makes the bake-off worthless, whereas a false
 * positive costs one scenario and an obvious fix (the harness reports the offending
 * excerpt and the block it came from, so the operator can see in one line that it was a
 * story about poetry and not a leak). We do not soften this into a warning: a check that
 * can be ignored is not a check. `prompts/judge.v1.md` is written to avoid all four words.
 */
export const IDENTITY_BRAND_WORDS = ['opus', 'sonnet', 'haiku', 'fable'] as const

/** Every model id that could appear in a bake-off, from config - never a literal. */
export function contestantModelIds(): string[] {
  const ids = new Set<string>(models.bakeoff_contestants)
  for (const role of Object.values(models.roles)) ids.add(role.model)
  for (const id of Object.keys(models.capabilities)) ids.add(id)
  return [...ids]
}

export interface IdentityLeak {
  needle: string
  kind: 'model_id' | 'brand_word'
  index: number
  excerpt: string
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40)
  const end = Math.min(text.length, index + length + 40)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
}

function findAll(text: string, needle: string, kind: IdentityLeak['kind']): IdentityLeak[] {
  const haystack = text.toLowerCase()
  const lower = needle.toLowerCase()
  const out: IdentityLeak[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(lower, from)
    if (at === -1) break
    out.push({ needle, kind, index: at, excerpt: excerptAround(text, at, needle.length) })
    from = at + lower.length
  }
  return out
}

/** Every occurrence of a model id or brand word, in order. */
export function findIdentityLeaks(text: string): IdentityLeak[] {
  const leaks: IdentityLeak[] = []
  // Model ids first: they are the unambiguous, always-fatal case.
  for (const id of contestantModelIds()) leaks.push(...findAll(text, id, 'model_id'))
  for (const word of IDENTITY_BRAND_WORDS) leaks.push(...findAll(text, word, 'brand_word'))
  // A model id such as "claude-opus-5-5" also matches the brand word inside it. Report
  // the id once rather than twice for the same character range.
  const idRanges = leaks
    .filter((l) => l.kind === 'model_id')
    .map((l) => [l.index, l.index + l.needle.length] as const)
  return leaks
    .filter(
      (l) =>
        l.kind === 'model_id' ||
        !idRanges.some(([start, end]) => l.index >= start && l.index < end),
    )
    .sort((a, b) => a.index - b.index)
}

export class BlindnessViolationError extends Error {
  constructor(
    readonly where: string,
    readonly leaks: IdentityLeak[],
  ) {
    super(
      `Judge payload is not blind (${where}): ${leaks.length} identity leak(s).\n` +
        leaks
          .slice(0, 8)
          .map((l) => `  - ${l.kind} "${l.needle}" at ${l.index}: ${l.excerpt}`)
          .join('\n') +
        `\nJUDGE_AGENT.md §2: the judge sees story text only. Every pairwise verdict in a ` +
        `run where this fires is contaminated, so the run is aborted rather than reported.`,
    )
    this.name = 'BlindnessViolationError'
  }
}

/** Throws unless the payload is clean. Called before every judge request. */
export function assertBlind(payloadText: string, where: string): void {
  const leaks = findIdentityLeaks(payloadText)
  if (leaks.length > 0) throw new BlindnessViolationError(where, leaks)
}
