import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/**
 * The merge decision for a pull request (issue #13, DECISIONS #151).
 *
 * The reviewer agent gives an opinion; this file turns it into an action. It is the
 * required status check `agent review / verdict`, run from `main` by
 * `.github/workflows/pr-review.yml`, so a PR cannot change the rules it is judged by.
 *
 * `decide()` is pure and unit-tested (VT-AR1). `main()` reads the PR with `gh`, calls
 * `decide()`, and applies the result: a review, labels, auto-merge, and the exit code.
 */

export type Verdict = 'approve' | 'request_changes' | 'needs_human'

export interface ReviewerOutput {
  verdict: Verdict
  summary: string
  blocking?: string[]
}

export const OWNER_APPROVED = 'owner-approved'
export const NEEDS_OWNER = 'needs-owner'

/** The reviewer bot asks the author to fix things this many times, then the owner decides. */
export const MAX_CHANGE_ROUNDS = 2

/**
 * CLAUDE.md's "stop and ask the owner" list, as paths. A directory ends in `/`, a prefix
 * in `.`, anything else is an exact file. Includes everything that defines this process,
 * so the reviewer cannot be re-briefed, or this file rewritten, without the owner.
 */
export const OWNER_ONLY_PATHS: readonly string[] = [
  'GUARDRAILS.md',
  'CLAUDE.md',
  'config/pricing.json',
  'config/models.json',
  'config/guardrails/',
  'prompts/master.',
  'prompts/judge.',
  'prompts/guardrail.',
  'lib/schemas/',
  'lib/limits/',
  'lib/owner.ts',
  '.claude/',
  '.githooks/',
  '.github/',
  'scripts/pr-decide.ts',
]

export function isOwnerOnlyPath(file: string): boolean {
  return OWNER_ONLY_PATHS.some((p) =>
    p.endsWith('/') || p.endsWith('.') ? file.startsWith(p) : file === p,
  )
}

export interface DecideInput {
  /** The GitHub event action: opened | synchronize | reopened | ready_for_review | labeled | dispatch. */
  action: string
  /** On a `labeled` event: which label, and who added it. */
  label?: { name: string; addedBy: string }
  repoOwner: string
  /** The reviewer's structured verdict, or null when it did not run or failed. */
  reviewer: ReviewerOutput | null
  /** Why the reviewer has no verdict, when it has none. */
  reviewerFailure?: string
  changedFiles: readonly string[]
  /** CHANGES_REQUESTED reviews the bot has already left on this PR. */
  priorChangeRounds: number
  labels: readonly string[]
}

export interface Decision {
  /** The required check passes. */
  pass: boolean
  review: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string } | null
  autoMerge: boolean
  addLabels: string[]
  removeLabels: string[]
  /** One line for the job summary. */
  reason: string
}

const HOW_TO_RELEASE = `The owner releases this PR by adding the \`${OWNER_APPROVED}\` label (a new commit removes it again).`

function reviewerSection(r: ReviewerOutput): string {
  const blocking = r.blocking?.length ? `\n\n**Blocking**\n${r.blocking.map((b) => `- ${b}`).join('\n')}` : ''
  return `**Reviewer verdict:** \`${r.verdict}\`\n\n${r.summary}${blocking}`
}

export function decide(input: DecideInput): Decision {
  const has = (l: string) => input.labels.includes(l)

  if (input.action === 'labeled') {
    const ok = input.label?.name === OWNER_APPROVED && input.label.addedBy === input.repoOwner
    if (!ok) {
      return {
        pass: false,
        review: null,
        autoMerge: false,
        addLabels: [],
        removeLabels: input.label?.name === OWNER_APPROVED ? [OWNER_APPROVED] : [],
        reason: `label "${input.label?.name}" by ${input.label?.addedBy} is not the owner's approval`,
      }
    }
    return {
      pass: true,
      review: { event: 'COMMENT', body: `Owner approved (\`${OWNER_APPROVED}\` by @${input.repoOwner}). Auto-merge enabled; merges when CI is green.` },
      autoMerge: true,
      addLabels: [],
      removeLabels: has(NEEDS_OWNER) ? [NEEDS_OWNER] : [],
      reason: 'owner approved',
    }
  }

  // New commits invalidate an earlier owner approval, like dismissing a stale review.
  const removeLabels = input.action === 'synchronize' && has(OWNER_APPROVED) ? [OWNER_APPROVED] : []
  const ownerPaths = input.changedFiles.filter(isOwnerOnlyPath)
  const needsOwner = (reason: string, body: string): Decision => ({
    pass: false,
    review: { event: 'COMMENT', body: `${body}\n\n${HOW_TO_RELEASE}` },
    autoMerge: false,
    addLabels: has(NEEDS_OWNER) ? [] : [NEEDS_OWNER],
    removeLabels,
    reason,
  })

  if (!input.reviewer) {
    return {
      pass: false,
      review: {
        event: 'COMMENT',
        body: `The reviewer did not produce a verdict (${input.reviewerFailure ?? 'unknown reason'}). Re-run the "agent review" workflow for this PR, or the owner can add \`${OWNER_APPROVED}\`.`,
      },
      autoMerge: false,
      addLabels: [],
      removeLabels,
      reason: `no verdict: ${input.reviewerFailure ?? 'unknown reason'}`,
    }
  }

  const r = input.reviewer
  if (ownerPaths.length > 0) {
    return needsOwner(
      `owner-only paths changed: ${ownerPaths.join(', ')}`,
      `This PR changes owner-only paths:\n${ownerPaths.map((p) => `- \`${p}\``).join('\n')}\n\n${reviewerSection(r)}`,
    )
  }
  if (r.verdict === 'needs_human') {
    return needsOwner('reviewer asked for the owner', reviewerSection(r))
  }
  if (r.verdict === 'request_changes') {
    if (input.priorChangeRounds >= MAX_CHANGE_ROUNDS) {
      return needsOwner(
        `changes requested ${input.priorChangeRounds} times already`,
        `The reviewer has asked for changes ${input.priorChangeRounds} times on this PR; handing it to the owner rather than looping.\n\n${reviewerSection(r)}`,
      )
    }
    return {
      pass: false,
      review: { event: 'REQUEST_CHANGES', body: reviewerSection(r) },
      autoMerge: false,
      addLabels: [],
      removeLabels,
      reason: 'changes requested',
    }
  }
  return {
    pass: true,
    review: { event: 'APPROVE', body: `${reviewerSection(r)}\n\nAuto-merge enabled; merges when CI is green.` },
    autoMerge: true,
    addLabels: [],
    removeLabels: [...removeLabels, ...(has(NEEDS_OWNER) ? [NEEDS_OWNER] : [])],
    reason: 'approved',
  }
}

// ----------------------------------------------------------------------------- the job

const BOT_LOGIN = 'github-actions[bot]'

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
}

function parseReviewer(raw: string | undefined): ReviewerOutput | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewerOutput>
    if (parsed.verdict !== 'approve' && parsed.verdict !== 'request_changes' && parsed.verdict !== 'needs_human') return null
    return { verdict: parsed.verdict, summary: parsed.summary ?? '', blocking: parsed.blocking ?? [] }
  } catch {
    return null
  }
}

function main(): void {
  const env = process.env
  const repo = env.REPO!
  const pr = env.PR_NUMBER!
  const reviewer = parseReviewer(env.REVIEWER_OUTPUT)
  const reviewerFailure =
    env.REVIEW_RESULT === 'skipped' ? 'review job skipped' : env.REVIEW_RESULT !== 'success' ? `review job ${env.REVIEW_RESULT}` : 'no structured verdict'

  const changedFiles = gh(['api', `repos/${repo}/pulls/${pr}/files`, '--paginate', '-q', '.[].filename']).split('\n').filter(Boolean)
  const reviews = JSON.parse(gh(['api', `repos/${repo}/pulls/${pr}/reviews`, '--paginate']) || '[]') as { user: { login: string }; state: string }[]
  const priorChangeRounds = reviews.filter((r) => r.user.login === BOT_LOGIN && r.state === 'CHANGES_REQUESTED').length
  const labels = gh(['pr', 'view', pr, '--repo', repo, '--json', 'labels', '-q', '.labels[].name']).split('\n').filter(Boolean)

  const decision = decide({
    action: env.EVENT_ACTION ?? 'dispatch',
    label: env.LABEL_NAME ? { name: env.LABEL_NAME, addedBy: env.LABEL_SENDER ?? '' } : undefined,
    repoOwner: env.REPO_OWNER!,
    reviewer,
    reviewerFailure,
    changedFiles,
    priorChangeRounds,
    labels,
  })

  for (const label of decision.addLabels) {
    gh(['label', 'create', label, '--repo', repo, '--force', '--color', label === NEEDS_OWNER ? 'D93F0B' : '0E8A16', '--description', label === NEEDS_OWNER ? 'Waits for the owner' : 'The owner released this PR'])
    gh(['pr', 'edit', pr, '--repo', repo, '--add-label', label])
  }
  for (const label of decision.removeLabels) gh(['pr', 'edit', pr, '--repo', repo, '--remove-label', label])
  if (decision.review) {
    const flag = { APPROVE: '--approve', REQUEST_CHANGES: '--request-changes', COMMENT: '--comment' }[decision.review.event]
    gh(['pr', 'review', pr, '--repo', repo, flag, '--body', decision.review.body])
  }
  if (decision.autoMerge) gh(['pr', 'merge', pr, '--repo', repo, '--auto', '--squash', '--delete-branch'])

  const line = `${decision.pass ? '✅' : '⛔'} ${decision.reason}`
  console.log(line)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`)
  process.exitCode = decision.pass ? 0 : 1
}

if (process.argv[1]?.endsWith('pr-decide.ts')) main()
