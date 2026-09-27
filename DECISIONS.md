# Decisions

One line each: what, why, date. Recorded where the planning documents were silent
(kickoff: "Where the documents are silent, use your judgment and record the decision").

## 2026-09-27 — Phase 0

| # | Decision | Why |
|---|---|---|
| 1 | Bake-off's "current Opus" is **Claude Opus 5.5** (`claude-opus-5-5`, $4/$20), not Opus 5 | Live docs (fetched 2026-09-27) show 5.5 as current. It is *cheaper* than the Opus 5 the plan assumed, and its cache-read multiplier is 0.05× rather than 0.1×, so it is a more plausible writing model than the plan expected. |
| 2 | Helper model pinned to the dated snapshot `claude-haiku-4-5-20251001`, not the `claude-haiku-4-5` alias | For Haiku 4.5 the dateless form is a convenience pointer, not its own snapshot. Eval and bake-off results must be reproducible, so the helper model is pinned. |
| 3 | Judge: **Fable 5.1 primary, Opus 5.5 secondary**, with self-preference bias reported rather than engineered away | `JUDGE_AGENT.md` §2 wants the strongest available model as judge and prefers a judge that is not a contestant. Both conditions cannot hold: the two strongest models are both contestants. §6 step 5 already requires a second judge and an agreement rate, so we use that mechanism and state the caveat explicitly on the Fable and Opus rows of the report. |
| 4 | **Server-side refusal fallbacks are NOT enabled.** `stop_reason: "refusal"` is logged and raised as `ModelRefusalError` | In a children's product a model declining a request is signal we want to see. Silently rerouting to another model would bypass the guardrail design and hide the event from `generation_logs`. |
| 5 | Fact-pack builder runs on Sonnet 5, not Haiku | It needs the `web_search_20260209` server tool, which Haiku 4.5 does not support. Runs once per topic, so the cost is amortized to near zero. |
| 6 | Helper calls send **no thinking config at all** | Normalize, classify, quality, bible-update and repair are structured extraction. Haiku 4.5 also takes only the older `budget_tokens` mode and rejects `effort`; the wrapper encodes this per-model rather than assuming a uniform API. |
| 7 | `callModel()` runs its **own** retry loop with the SDK at `maxRetries: 0` | F8 AC requires a `generation_logs` row for every call including failures. The SDK's internal retries are invisible, so they would under-report attempts and cost. |
| 8 | Cost is recomputed from `config/pricing.json` on **every** log write, never stored by the caller | Kickoff rule 2. A single code path means a price correction is a config edit, not a code change. |
| 9 | Word count for gate/judge purposes = **chapter bodies + ending line**, excluding headings and the True Facts list | The band table in §4.5 describes read-aloud narrative length. Counting headings and the facts list would let a story pad its way into range. |
| 10 | Ages 1–2 map to **band A** | §4.5 starts band A at age 3 but the data model permits age 1. Band A is the only safe default. |
| 11 | Judge `overall` is **recomputed** from the criterion scores; the model's own arithmetic is discarded | Cheap determinism. A judge that miscounts its own weighted mean would silently distort every comparison. |
| 12 | Automatic caps (`JUDGE_AGENT.md` §3) are applied in **our** code, not requested from the judge | Same reason: a cap that the model can forget to apply is not a cap. |
| 13 | Next.js **16** (plan says "15+"), Tailwind **4** | Both are the current majors; 16 satisfies the plan's floor. Tailwind 3.4.20 as written in my first draft does not exist. |
| 14 | `test/blocked/` holds tests that fail on an **external** dependency, excluded from `pnpm test` and run in a non-blocking CI job | Keeps the missing reference stories visible on every CI run without blocking unrelated PRs. See `test/blocked/README.md`. |
| 15 | `daily_usage` is **readable** by the family but writable only by the service role | The UI shows "2 of 3 stories left today", but a client must not be able to reset its own quota. |
| 16 | `generation_logs` and `guardrail_events` get **no RLS policies at all** | With RLS enabled and no permissive policy, anon/authenticated clients see nothing while the service role bypasses RLS. That is exactly the access model §3 asks for. |
| 17 | pnpm pinned at 12.6.0 with `allowBuilds` in `pnpm-workspace.yaml` | pnpm 12 renamed the build-approval setting from `onlyBuiltDependencies`; without it `pnpm install` exits 1 and CI stops on an interactive prompt. |

## Open — needs the owner

| # | Question | Default while waiting |
|---|---|---|
| A | **The four reference stories are missing from the handover archive.** | Proceeding on everything else; calibration and master-prompt style anchors are blocked and marked by a failing test in `test/blocked/`. Not substituting generated stories — see `storytime-plan/reference-stories/README.md`. |
| B | **Phase 3 bake-off exceeds the $20 threshold**: ~$37 with Opus 5.5 as judge, ~$55 with Fable 5.1. | Will bring an exact figure computed from `config/pricing.json` plus a cheaper 2-sample variant before running anything. |
| C | `DAILY_BUDGET_USD` production value. | `5` in `.env.example`. |
| D | Docker Desktop's VM disk is full (890 orphaned anonymous volumes, 46GB), so local Supabase cannot start. | Migrations are unverified locally; the CI `migrations` job verifies them on a clean runner. Not pruning volumes on the owner's machine without permission. |

## Appendix B defaults adopted (plan says do not block on these)

| Question | Default taken |
|---|---|
| B1 Tone list | funny, exciting, calm, mysterious, silly, heart-warming (enum in `lib/schemas/common.ts`, max 2 per story) |
| B2 Parent-editable Story Bible | v1.1, not v1. Not built; no flag needed yet. |
| B3 Suggested-topic chips | Both — 4 evergreen + 4 most-used fact packs |
