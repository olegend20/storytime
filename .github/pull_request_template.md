## What a parent sees

<!-- One or two sentences. Link the issue. -->

## Acceptance tests

<!-- The VTs this PR makes pass, by name/path. A feature is done only when every one passes in CI (CLAUDE.md rule 4). -->

- [ ] …

## Evidence

<!-- What was measured. Before/after numbers. Cost per story if the generation path changed. -->

## Checklist

- [ ] Gates green locally: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:guardrails`, `pnpm test:e2e`, `pnpm test:e2e:real`
- [ ] No new field about a child (first name, age, likes, notes, reading level only — rule 7)
- [ ] No direct SDK call; every model call goes through `callModel()` / `streamModel()` (rule 1)
- [ ] `lib/schemas/` unchanged, or the change is additive and called out here
- [ ] Prompts unchanged, or `master`/`judge`/guardrail changes carry the eval before/after here (rule 5)
- [ ] `DECISIONS.md` has a row for every decision made; `PROGRESS.md` updated
- [ ] AI review run (`/code-review`) and its findings addressed or answered
- [ ] Nothing here spent API credit without the owner's approval and a cost figure
