# test/blocked/ — tests that fail because we're waiting on the owner

Tests here assert a dependency that is **outside the team's control**. They are excluded
from `pnpm test` (and so from the PR-blocking CI job) and run instead in a separate
`blocked-on-owner` CI job that is allowed to fail but reports loudly on every run.

This keeps two things true at once: a genuine external gap never gets quietly forgotten,
and it never blocks unrelated work. When the dependency arrives, move the test into
`test/unit/` (or the right layer) so it becomes PR-blocking like everything else.

## Currently blocked

**Nothing.** The directory is intentionally kept for the next time it is needed.

## Resolved

| Test | Was waiting on | Resolved |
|---|---|---|
| `reference-stories.test.ts` | The four reference stories, missing from the handover archive | 2026-09-27 — owner supplied them; test promoted to `test/unit/` and is now merge-blocking |
