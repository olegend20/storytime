import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OWNER_ONLY_PATHS, isOwnerOnlyPath } from '../../scripts/pr-decide'

/**
 * VT-AR2 (issue #13): the reviewer workflow's safety properties, read straight from the
 * file, so a later edit that loosens them fails here before it reaches `main`.
 */

const workflow = readFileSync('.github/workflows/pr-review.yml', 'utf8')
const claudeArgs = workflow.slice(workflow.indexOf('claude_args:'), workflow.indexOf('verdict:', workflow.indexOf('claude_args:')))
const allowed = /--allowedTools "([^"]*)"/.exec(claudeArgs)?.[1] ?? ''
const disallowed = /--disallowedTools "([^"]*)"/.exec(claudeArgs)?.[1] ?? ''

describe('pr-review workflow', () => {
  it('runs on pull_request_target so the rules always come from main', () => {
    expect(workflow).toMatch(/^on:\n\s+pull_request_target:/m)
    expect(workflow).not.toMatch(/^\s+pull_request:\s*$/m)
  })

  it('only this repository\'s own, non-draft, non-Dependabot PRs are eligible, in both jobs', () => {
    const guards = workflow.match(/head\.repo\.full_name == github\.repository/g) ?? []
    expect(guards.length).toBe(2)
    expect(workflow.match(/pull_request\.draft == false/g)?.length).toBe(2)
    expect(workflow.match(/github\.actor != 'dependabot\[bot\]'/g)?.length).toBe(2)
  })

  it('a labeled event runs only for the owner-approved label, and never the reviewer', () => {
    expect(workflow).toContain("github.event.action != 'labeled' || github.event.label.name == 'owner-approved'")
    expect(workflow).toMatch(/review:\n\s+name: review\n\s+if: >-\n\s+github\.event\.action != 'labeled'/)
  })

  it('the PR code is checked out beside the workspace, not into it', () => {
    expect(workflow).toContain('ref: refs/pull/${{ env.PR }}/head')
    expect(workflow).toContain('path: pr-head')
  })

  it('the reviewer runs on the subscription token, pinned model, fixture mode', () => {
    expect(workflow).toContain('claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}')
    expect(workflow).not.toContain('anthropic_api_key:')
    expect(claudeArgs).toContain('--model claude-opus-5-5')
    expect(workflow).toContain("LIVE_API: '0'")
  })

  it('the reviewer can read and run fixture gates, but not edit, push, review or merge', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'Bash(gh pr diff:*)']) expect(allowed).toContain(tool)
    for (const banned of ['Edit', 'Write', 'MultiEdit']) expect(disallowed.split(',')).toContain(banned)
    for (const banned of ['git push', 'gh pr merge', 'gh pr review', 'gh api', 'gh pr edit', 'Bash)', 'Bash,']) expect(allowed).not.toContain(banned)
    expect(allowed).not.toMatch(/(^|,)Bash(,|$)/) // no unrestricted shell
  })

  it('the verdict comes back as structured output with the three verdicts', () => {
    expect(claudeArgs).toContain('--json-schema')
    expect(claudeArgs).toContain('"enum":["approve","request_changes","needs_human"]')
  })

  it('the required check is the verdict job, and it is the only job with write access', () => {
    expect(workflow).toContain('name: agent review / verdict')
    expect(workflow).toMatch(/^permissions:\n\s+contents: read\s*$/m)
    const reviewJob = workflow.slice(workflow.indexOf('  review:'), workflow.indexOf('  verdict:'))
    expect(reviewJob).toContain('contents: read')
    expect(reviewJob).not.toContain('contents: write')
    expect(workflow).toContain('run: pnpm tsx scripts/pr-decide.ts')
  })
})

describe('owner-only paths cover CLAUDE.md\'s "stop and ask" list', () => {
  it.each([
    ['guardrails', 'GUARDRAILS.md'],
    ['prices', 'config/pricing.json'],
    ['model IDs', 'config/models.json'],
    ['the schema contract', 'lib/schemas/story.ts'],
    ['daily limit and budget cap', 'lib/limits/quota.ts'],
    ['the writing prompt', 'prompts/master.v2.md'],
    ['the judge prompt', 'prompts/judge.v2.md'],
    ['the guardrail classifier prompt', 'prompts/guardrail.input-classifier.v1.md'],
    ['refusal copy', 'config/guardrails/messages.json'],
    ['the agent rules', 'CLAUDE.md'],
    ['this workflow', '.github/workflows/pr-review.yml'],
    ['the review standard', '.github/pr-review-standard.md'],
    ['the decision script', 'scripts/pr-decide.ts'],
  ])('%s (%s)', (_what, file) => expect(isOwnerOnlyPath(file)).toBe(true))

  it('every listed path exists in the repo in some form', () => {
    // A stale entry would silently protect nothing.
    for (const p of OWNER_ONLY_PATHS) {
      if (p.endsWith('/')) expect(existsSync(p), p).toBe(true)
      else if (p.endsWith('.')) {
        const [dir, prefix] = [p.slice(0, p.lastIndexOf('/')), p.slice(p.lastIndexOf('/') + 1)]
        expect(readdirSync(dir).some((f) => f.startsWith(prefix)), p).toBe(true)
      } else expect(existsSync(p), p).toBe(true)
    }
  })
})
