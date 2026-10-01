import { describe, expect, it } from 'vitest'
import {
  decide,
  isOwnerOnlyPath,
  MAX_CHANGE_ROUNDS,
  NEEDS_OWNER,
  OWNER_APPROVED,
  type DecideInput,
} from '../../scripts/pr-decide'

/** VT-AR1 (issue #13): the merge decision is a table, and this is the table. */

const base: DecideInput = {
  action: 'opened',
  repoOwner: 'olegend20',
  reviewer: { verdict: 'approve', summary: 'Looks right.', blocking: [] },
  changedFiles: ['lib/kindle/send.ts', 'test/int/kindle.test.ts'],
  priorChangeRounds: 0,
  labels: [],
}

describe('decide', () => {
  it('approve → approving review, auto-merge, check passes', () => {
    const d = decide(base)
    expect(d.pass).toBe(true)
    expect(d.review?.event).toBe('APPROVE')
    expect(d.autoMerge).toBe(true)
    expect(d.addLabels).toEqual([])
  })

  it('request_changes → changes requested, check fails, no label', () => {
    const d = decide({ ...base, reviewer: { verdict: 'request_changes', summary: 'Two things.', blocking: ['lib/x.ts: handle null'] } })
    expect(d.pass).toBe(false)
    expect(d.review?.event).toBe('REQUEST_CHANGES')
    expect(d.review?.body).toContain('lib/x.ts: handle null')
    expect(d.autoMerge).toBe(false)
    expect(d.addLabels).toEqual([])
  })

  it(`after ${MAX_CHANGE_ROUNDS} rounds of changes it goes to the owner instead of looping`, () => {
    const d = decide({ ...base, reviewer: { verdict: 'request_changes', summary: 'Still.' }, priorChangeRounds: MAX_CHANGE_ROUNDS })
    expect(d.pass).toBe(false)
    expect(d.review?.event).toBe('COMMENT')
    expect(d.addLabels).toEqual([NEEDS_OWNER])
  })

  it('an owner-only path needs the owner even when the reviewer approves', () => {
    const d = decide({ ...base, changedFiles: ['lib/kindle/send.ts', 'config/pricing.json'] })
    expect(d.pass).toBe(false)
    expect(d.autoMerge).toBe(false)
    expect(d.review?.event).toBe('COMMENT')
    expect(d.review?.body).toContain('config/pricing.json')
    expect(d.review?.body).toContain(OWNER_APPROVED)
    expect(d.addLabels).toEqual([NEEDS_OWNER])
  })

  it('needs_human → needs the owner', () => {
    const d = decide({ ...base, reviewer: { verdict: 'needs_human', summary: 'Adds a column about a child.' } })
    expect(d.pass).toBe(false)
    expect(d.addLabels).toEqual([NEEDS_OWNER])
    expect(d.review?.body).toContain('Adds a column about a child.')
  })

  it('no verdict (reviewer failed) → check fails with the reason, no label, no auto-merge', () => {
    const d = decide({ ...base, reviewer: null, reviewerFailure: 'review job failure' })
    expect(d.pass).toBe(false)
    expect(d.reason).toContain('review job failure')
    expect(d.addLabels).toEqual([])
    expect(d.autoMerge).toBe(false)
  })

  it(`the owner adding ${OWNER_APPROVED} passes the check and enables auto-merge`, () => {
    const d = decide({ ...base, action: 'labeled', reviewer: null, labels: [NEEDS_OWNER, OWNER_APPROVED], label: { name: OWNER_APPROVED, addedBy: 'olegend20' } })
    expect(d.pass).toBe(true)
    expect(d.autoMerge).toBe(true)
    expect(d.removeLabels).toEqual([NEEDS_OWNER])
  })

  it('the same label from anyone else does nothing, and is removed', () => {
    const d = decide({ ...base, action: 'labeled', reviewer: null, labels: [OWNER_APPROVED], label: { name: OWNER_APPROVED, addedBy: 'someone-else' } })
    expect(d.pass).toBe(false)
    expect(d.autoMerge).toBe(false)
    expect(d.removeLabels).toEqual([OWNER_APPROVED])
  })

  it('a new commit strips an earlier owner approval', () => {
    const d = decide({ ...base, action: 'synchronize', labels: [OWNER_APPROVED], changedFiles: ['config/models.json'] })
    expect(d.pass).toBe(false)
    expect(d.removeLabels).toContain(OWNER_APPROVED)
  })

  it('approval after a needs-owner round clears the label', () => {
    const d = decide({ ...base, action: 'synchronize', labels: [NEEDS_OWNER] })
    expect(d.pass).toBe(true)
    expect(d.removeLabels).toEqual([NEEDS_OWNER])
  })
})

describe('isOwnerOnlyPath', () => {
  it.each([
    'GUARDRAILS.md',
    'CLAUDE.md',
    'config/pricing.json',
    'config/models.json',
    'config/guardrails/messages.json',
    'prompts/master.v3.md',
    'prompts/judge.v2.md',
    'prompts/guardrail.input-classifier.v1.md',
    'lib/schemas/quality.ts',
    'lib/limits/quota.ts',
    'lib/owner.ts',
    '.github/workflows/pr-review.yml',
    '.github/pr-review-standard.md',
    '.claude/skills/feature/SKILL.md',
    '.githooks/pre-push',
    'scripts/pr-decide.ts',
  ])('%s is owner-only', (f) => expect(isOwnerOnlyPath(f)).toBe(true))

  it.each(['lib/kindle/send.ts', 'prompts/factpack.v3.md', 'config/bands.json', 'DECISIONS.md', 'scripts/seed.ts', 'test/unit/pr-decide.test.ts'])(
    '%s is not',
    (f) => expect(isOwnerOnlyPath(f)).toBe(false),
  )
})
