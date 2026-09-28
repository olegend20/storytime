# test/blocked/ — tests that fail because we're waiting on the owner

Tests here assert a dependency that is **outside the team's control**. They are excluded
from `pnpm test` (and so from the PR-blocking CI job) and run instead in a separate
`blocked-on-owner` CI job that is allowed to fail but reports loudly on every run.

This keeps two things true at once: a genuine external gap never gets quietly forgotten,
and it never blocks unrelated work. When the dependency arrives, move the test into
`test/unit/` (or the right layer) so it becomes PR-blocking like everything else.

## Currently blocked

**Waiting on: a working `ANTHROPIC_API_KEY`.** `.env.local` currently holds a 34-character
placeholder (`sk-ant-plac…`), there is no `ant` CLI on the machine and no
`~/.config/anthropic` profile, so a live call returns **401**. Nothing here can be recorded
until a real key is available. Run them with:

```bash
LIVE_API=1 RECORD_FIXTURES=1 pnpm test:blocked   # record, then they replay in pnpm test
```

Estimated one-off cost of that recording run, computed from `config/pricing.json`:
**≈ $0.75** (4 fact packs with web search ≈ $0.68, ~15 Haiku calls ≈ $0.03, plus the two
live Sonnet calls the cache test needs ≈ $0.13 — the cache test cannot be replayed at all,
see below).

| Test | VT it verifies | Why a synthetic fixture would not do |
|---|---|---|
| `normalize.test.ts` | **F5 VT1, VT2** — six synonym inputs collapse onto three `topic_key`s; "how to make a weapon" is refused | The assertion *is* the model's judgement. A fixture we wrote ourselves would be asserting our own answer. |
| `factpack-live.test.ts` | **F5 VT5** — real packs for the four reference topics, ≥15 facts each, ≥3 anchor facts | Needs real web research. Anchor facts ("leg godt", "1958", "McCrum", "Pickles") only appear if the search actually happened. |
| `bible-update.test.ts` | **F4 VT4** — old bible + the Shark Submarine reference → a recurring entry containing "Greenie" and an ending mentioning a tooth | Same: it tests whether Haiku extracts the right continuity, not whether our plumbing carries it. |
| `cache.test.ts` | **F6 VT6 / AC** — `cache_read_tokens` ≥ 90% of the cached master block on the second write call | **Cannot ever be replayed.** A fixture would just repeat a recorded usage number. This one needs a live run every time it is trusted. |

`test/int/pipeline.test.ts` deliberately does **not** live here: it drives the whole
streamed pipeline against synthetic payloads written into the temp `FIXTURE_DIR`
(`test/helpers/fixtures.ts`), which is enough to verify our plumbing — SSE ordering, the
gate's decisions, the save, the quota call sites, the bible trigger — and is explicit about
proving nothing about the real writing model's output.

## Resolved

| Test | Was waiting on | Resolved |
|---|---|---|
| `reference-stories.test.ts` | The four reference stories, missing from the handover archive | 2026-09-27 — owner supplied them; test promoted to `test/unit/` and is now merge-blocking |
