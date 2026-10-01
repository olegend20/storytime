---
name: feature
description: Build a StoryTime feature the agreed way — issue with acceptance tests first, a branch and worktree, gates before the PR, AI review, evidence in the PR. Use whenever the owner asks to build, add, or change a feature, or types /feature.
---

# Building a feature in StoryTime

Follow these steps in order. Do not skip to code.

## 1. Write it down first (the issue)

Before any code, draft a GitHub issue and show it to the owner:

- **What a parent sees** — one or two sentences, in the product's own words.
- **Acceptance tests** — named tests you will write (this project calls them VTs). Each is
  something a test can check: a page state, a stored row, a number. "Kids like it" is not one.
- **What must not change** — cost per story, the guardrails, `lib/schemas/`, children's data.
- **Decisions the owner must make** — anything CLAUDE.md's "stop and ask" list covers.

Create it with `gh issue create` once the owner agrees. Then design if the feature needs it:
a short design in the issue, options with a recommendation, the owner picks.

## 2. Branch and worktree

`main` is protected; nothing is committed to it directly.

```
git worktree add ../storybot-<slug> -b feat/<slug>
```

Work there. One feature, one branch, one PR. Keep the PR under a day's work; split if not.

## 3. Build with the tests

Write the acceptance tests with the code, not after. Run the full gates before opening the
PR — all of them, every time, even for a one-line change:

```
pnpm lint && pnpm typecheck && pnpm test && pnpm test:guardrails && pnpm test:e2e && pnpm test:e2e:real
```

(`supabase start` first.) Fix what fails. Never weaken a test to make it pass; if the test is
wrong, say so and why.

Record every non-obvious decision as a row in `DECISIONS.md` with the *why*. Update
`PROGRESS.md`. If you changed `prompts/master.*`, `prompts/judge.*` or a guardrail prompt,
rule 5 applies: the eval before/after goes in the PR, and running it needs the owner's
approval with a cost figure first.

## 4. Open the PR

`gh pr create` with the template filled in: what a parent sees, the acceptance tests by name,
the evidence (numbers), the checklist honestly ticked. Commits end with the attribution lines
the session gives you.

## 5. Review, then merge

Run `/code-review` on the PR and address every finding — fix it, or answer it in the PR.
Then the reviewer agent takes over (`.github/workflows/pr-review.yml`): it reviews against
`.github/pr-review-standard.md` and the required check `agent review / verdict` decides.

- **Approved** → auto-merge is enabled; it squash-merges when CI is green. Nothing to do.
- **Changes requested** → fix every blocking item, push; the review re-runs. After two
  rounds it escalates to the owner instead of looping.
- **`needs-owner` label** → the PR touches an owner-only path (`OWNER_ONLY_PATHS` in
  `scripts/pr-decide.ts`) or the reviewer wants a human. Tell the owner what to look at
  and why; they release it with the `owner-approved` label. Never add that label yourself,
  never split a change to dodge the list.

After the merge, delete the worktree (`git worktree remove ../storybot-<slug>`) and pull
`main`. Dependabot PRs are the owner's to merge.

## What never happens

- Committing to `main`.
- Adding the `owner-approved` label, or editing the reviewer's rules, yourself.
- A live API call without the owner's explicit OK and a cost number.
- A new column, field or prompt line about a child beyond the five allowed.
- Marking something done without every one of its acceptance tests passing in CI.
