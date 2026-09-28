# Progress

Feature status against `storytime-plan/IMPLEMENTATION_PLAN.md` §6. VT counts are the
verification tests named in each feature's section (plus `GUARDRAILS.md` §7 and
`JUDGE_AGENT.md` §7 where those sections delegate).

**A feature is done only when every VT in its section passes in CI.** No exceptions.

| F | Feature | VTs | Passing | Status | Lane |
|---|---|---|---|---|---|
| F1 | Project scaffold and infrastructure | 3 | 3 | ✅ **done** — env, migrations + introspection, CI all green | 0 lead |
| F2 | Authentication and family account | 4 | 4 | ✅ **done** — magic link + family + settings + account deletion, all 4 VTs green | 1 |
| F3 | Children profiles | 3 | 3 | ✅ **done** — CRUD, 8-child ceiling, client+server validation | 1 |
| F4 | Series and Story Bible service | 6 | 0 | ⬜ not started | 2 |
| F5 | Topic normalization and Fact Packs | 6 | 2 | 🟡 schema/review VTs green; service pending | 2 |
| F6 | Story generation pipeline | 7 | 1 | 🟡 `targetWords` VT green; pipeline pending | 2 |
| F7 | Quality gate | 5 | 0 | ⬜ not started | 2 |
| F8 | Quotas and cost logging | 6 | 6 | ✅ **done** — quota, tz boundary, cost, freshness, budget cap, failure logging | 3 |
| F2 | Authentication and family account | 4 | 0 | ⬜ not started — RLS isolation pre-verified (16/16 probe checks) | 1 |
| F3 | Children profiles | 3 | 1 | 🟡 schema VT green; API + e2e pending | 1 |
| F4 | Series and Story Bible service | 6 | 4 | 🟡 4/6 green; VT4 blocked on an API key, VT6 is lane 5's eval | 2 |
| F5 | Topic normalization and Fact Packs | 6 | 3 | 🟡 3/6 green; VT1/VT2/VT5 blocked on an API key | 2 |
| F6 | Story generation pipeline | 7 | 5 | 🟡 5/7 green; cache-read VT blocked on an API key, e2e is lane 4's | 2 |
| F7 | Quality gate | 5 | 5 | ✅ **done** — all 5 VTs green, references pass the gate | 2 |
| F8 | Quotas and cost logging | 6 | 3 | 🟡 cost + freshness VTs green; quota/budget pending | 3 |
| F9 | Story library and reader | 4 | 0 | ⬜ not started | 4 |
| F10 | New-story flow (UI) | 5 | 0 | ⬜ not started | 4 |
| F11 | Safety, privacy and content policy | 5 | 0 | ⬜ not started | 1 + 4 |
| F12 | Admin dashboard | 3 | 3 | ✅ **done** — owner gate 404s, view arithmetic, 80% hit rate | 3 |
| F13 | Quality evaluation harness | 3 | 2 | 🟡 **judge calibration PASSES 6/6 live.** Full eval run still to do | 5 |
| F14 | Model bake-off | 6 | 5 | 🟡 merged; 5/6. Live calibration VT written and skipped — needs credentials. **$54.79 run needs owner approval** | 5 |
| F15 | Guardrails | 10 | 8 | 🟡 **L1+L2 measured live: refuse recall 100.0% (136/136), allow false-refusal 1.2% (1/85)**. 2 VTs need F10's UI | 6 |
| F11 | Safety, privacy and content policy | 5 | 4 | 🟡 sanitizer, rate limit, privacy page, schema assertion green; the must-refuse topic VT is lane 6's L2 | 1 + 4 + 6 |
| F12 | Admin dashboard | 3 | 0 | ⬜ not started — SQL views written | 3 |
| F13 | Quality evaluation harness | 2 + JUDGE §7 | 0 | ⬜ not started — **unblocked**, references arrived | 5 |
| F14 | Model bake-off | JUDGE §7 (6) | 2 | 🟡 rubric/position-swap VTs green; harness pending. **Budget approval needed** | 5 |
| F15 | Guardrails | GUARDRAILS §7 (9) | 1 | 🟡 corpus contract locked; L1–L4 pending | 6 |

Legend: ⬜ not started · 🟡 in progress · 🔴 blocked · ✅ done

---

## Session log

### 2026-09-27 — Phase 0 (lead, solo)

**Features touched:** F1 (scaffold, CI, migrations, env validation), plus the shared
foundations every lane depends on.

**Delivered**
- Repo initialized; plan documents moved to the paths they refer to themselves by
  (`storytime-plan/`, `storytime-plan/agents/JUDGE_AGENT.md`).
- Toolchain: Node 26.8.1, pnpm 12.6.0 (pinned), Supabase CLI 2.118.0, Playwright 1.63.
- `config/pricing.json` + `config/models.json` built from **live** docs fetched
  2026-09-27, with page URLs and fetch dates cited in the files.
- `lib/schemas/` — the cross-lane contract: Story Bible (§4.2), Fact Pack (§4.3), story
  output (§4.4), quality gate (F7), guardrail L1/L2/L4 (GUARDRAILS.md), judge SCORE and
  PAIRWISE (JUDGE_AGENT.md §4), age bands and word targets (§4.5).
- `lib/ai/callModel()` + `streamModel()` — the single model entry point, with cost
  computation from config, per-attempt `generation_logs` rows, prompt-cache breakpoints,
  per-model capability handling, refusal detection, and fixture record/replay.
- `lib/env.ts` fail-fast env validation; `lib/supabase/{client,server,service}.ts`.
- Migrations: 9 tables, RLS on every family-scoped table, F12 admin views, the
  guardrail 24h raw-text retention function.
- CI: `check` (lint/typecheck/unit), `migrations`, `guardrails` (merge-blocking),
  `e2e`, and a non-blocking `blocked-on-owner` job; manual eval and nightly live
  guardrail workflows.

**Verified green:** `pnpm lint` ✅ · `pnpm typecheck` ✅ · `pnpm build` ✅ ·
`pnpm test` → **85 passed, 12 skipped, 0 failed**.

**API spend this session: $0.00.** No model calls were made — Phase 0 is scaffold,
schemas and the wrapper. `generation_logs` has no rows yet.

**Open questions for you** (detail in `DECISIONS.md` → Open)
1. **The four reference stories were not in the archive.** `files (1).zip` held only the
   three planning documents. This blocks judge calibration (and so the F13 eval gate) and
   the master prompt's style anchors. I have not substituted generated stories, and I'd
   advise against it — calibrating the judge on our own output and then grading our own
   output with it measures nothing. Please drop the four `.md` files into
   `storytime-plan/reference-stories/`.
2. **The Phase 3 bake-off costs more than your $20 stop-and-ask threshold:** ~$37 with
   Opus 5.5 as judge, ~$55 with Fable 5.1 as primary judge (which `JUDGE_AGENT.md` §2
   asks for). I'll bring an exact figure and a cheaper 2-sample variant before running it.
3. **`DAILY_BUDGET_USD`** — what value for production?
4. **Docker Desktop's VM disk is full** (890 orphaned anonymous volumes, ~46GB), so local
   Supabase won't start and I could not verify the migrations against a real database.
   Pruning volumes on your machine is your call — the 46GB is reclaimable with
   `docker volume prune -f`, which removes anonymous volumes only and leaves your two
   named `litellm-mvp-demo_*` volumes alone. CI verifies migrations on a clean runner
   regardless.

### 2026-09-27 (cont.) — reference stories received, F1 closed out

**Unblocked by you:** `reference-stories.zip` and approval to prune Docker volumes.

**Reference stories** — four stories + a `manifest.json` giving each story's original
request and prior bible. Written by `claude-fable-5-1`, confirming bake-off contestant 4.
Extracted to `storytime-plan/reference-stories/`; the guard test moved from
`test/blocked/` to `test/unit/` and is now **merge-blocking**, with 13 assertions covering
structure, word targets, chapter share, child coverage and manifest integrity.

Built `lib/reference.ts` — parses reference markdown into the `StoryOutput` shape so F7's
gate and the judge share one definition of "the story". Lane 5 uses it for calibration.

**Four findings from reading them** (all in `DECISIONS.md` #18–25):
1. **The §4.4 output schema has no cold-open field**, though §4.1.2 mandates a cold open.
   Resolved by folding it into `chapters[0]`, which is exactly what the references do.
2. **Ending style splits by band.** Band A closes with a bedtime address *after* "The End";
   band C closes on a forward-looking beat *before* it. A goodnight address to a 10-year-old
   would read as babyish — the master prompt must pick per band, not treat one as correct.
3. **Word count must be narrative-only**, confirmed empirically: raw file counts run ~12%
   high and would flag the shark reference (2,143 raw vs band A's 1,955 ceiling; 1,859
   narrative, comfortably inside). This validates the definition I'd already chosen.
4. **Both band A references exceed the nominal 1,700-word ceiling** and pass only on the
   ±15% tolerance. Worth knowing before anyone tightens that tolerance — the bar itself
   sits at the top of the band.

**Docker + database.** 46.34GB reclaimed; your two named `litellm-mvp-demo_*` volumes were
left untouched. With a database available I verified what was previously unverifiable:
- All four migrations apply cleanly to a fresh database.
- Schema introspection: 6/6 — all nine tables, all six admin views, and `children` proven
  to have no `last_name`/`birthdate`/`surname`/`photo_url`/`address` column.
- **RLS isolation: 16/16** via `scripts/dev/probe-rls.ts` — user A sees zero rows of user
  B's data (not an error), cannot insert into another family, cannot spoof family
  ownership, cannot reset its own quota; `generation_logs` and `guardrail_events` are
  invisible to authenticated clients but visible to the service role; `fact_packs` exposes
  only `status='ready'` rows and rejects client writes; the 24h retention function runs.
- `pnpm seed` works.

**Gates:** lint ✅ · typecheck ✅ · build ✅ · `pnpm test` → **98 passed, 0 failed**.

**F1 is done** — all three VTs green. **API spend this session: $0.00.**

**Still open for you:** the Phase 3 bake-off budget (~$37–55, above your $20 threshold)
and the production `DAILY_BUDGET_USD`. Neither blocks Phase 1.

### 2026-09-27 — Phase 1 launched

Six lanes running in isolated git worktrees (so they cannot collide in one working tree),
each briefed with `docs/LANE_BRIEF.md` plus a lane-specific brief naming its features, the
document sections to read, the schema contract, and the findings from the reference stories
that affect its work.

| Lane | Features | Brief emphasis |
|---|---|---|
| 1 Data & auth | F2, F3, F11 (server) | Told RLS is already verified 16/16 — don't redo it; suspect your query, not the policy |
| 2 AI core | F4, F5, F6, F7 | Must read all four references before writing the master prompt; the four band/structure findings; `lib/schemas/api.ts` is fixed |
| 3 Cost & ops | F8, F12 | 2 of 6 F8 VTs already green; views already exist; the Auckland/LA timezone VT called out specifically |
| 4 Frontend | F9, F10, F11 (UI) | Build against `lib/schemas/api.ts` with a mock SSE stream from day 1; refusal copy is lane 6's to write, theirs to render |
| 5 Eval & judge | F13, F14 | Build both harnesses, **do not run live** — bake-off needs owner approval; judge-blindness and prompt-injection tests first |
| 6 Safety | F15 | The corpus is the deliverable; report measured rates, not assumed ones; the L1-vs-schema boundary I already settled |

Before launching I added `lib/schemas/api.ts` — the HTTP/SSE contract between lanes 2 and 4,
which §7 makes the lead's to own. Without it those two lanes would have invented
incompatible event shapes and only discovered it at integration.

Standing instruction given to every lane: report each feature's VTs individually with real
pass/fail, and an honest red beats an optimistic green.
### 2026-09-27 — lane 3: F8 quotas and cost logging, F12 admin dashboard

**Features:** F8 ✅ 6/6 VTs · F12 ✅ 3/3 VTs. **API spend: $0.00** (the SDK is stubbed in
the failure/budget tests; no network call was made).

**F8 built**
- `lib/limits/timezone.ts` — the day boundary in the family's own zone, `Intl`-only, correct
  across DST transitions and 30/45-minute offsets.
- `lib/limits/quota.ts` — `quotaStatus()` (read, never consumes) and `consumeQuota()` (atomic
  claim). The increment is one statement in the new `consume_daily_quota` Postgres function,
  revoked from `anon`/`authenticated`.
- `lib/limits/switches.ts` — `GENERATION_ENABLED` / `DAILY_BUDGET_USD`, re-read from the
  environment on every call.
- `lib/limits/guard.ts` — `preflight()`, the gate lane 2's generate route calls first:
  503 `service_paused` → 503 `budget_exceeded` → 429 `quota_exceeded` with the local reset
  time. Consumes nothing, so refusals and failures stay free.
- `lib/costs/sink.ts` — the Supabase `GenerationLogSink`, installed at server boot from
  `instrumentation.ts`. `lib/costs/budget.ts` reads today's spend from a view.
- `lib/costs/expected.ts` — expected cost per story derived from §5 + `config/pricing.json`.
- `app/api/quota/route.ts` — `GET /api/quota` for F10's "2 of 3 stories left today" chip.

**F12 built**
- `app/admin/page.tsx` + `lib/admin/{gate,metrics}.ts`. Non-owner → `notFound()`, verified
  404 over real HTTP. Every number is a read of a `v_*` view; nothing is accumulated in
  process. The kill switch and budget cap are displayed read-only, and the page renders no
  form control at all.
- Migration `20260927000005` adds `v_budget_today`, `v_story_cost_summary`, `v_story_writer`,
  `v_story_cost_by_writer`, `v_story_health`, `v_latency_summary`,
  `v_fact_pack_hit_rate_daily`.

**Two findings worth other lanes' attention**
1. **The F12 admin views were world-readable.** `curl` with the anon key returned
   `v_daily_costs` — the day's spend, call counts and token totals — because the views are
   owned by `postgres` (so they bypass RLS on `generation_logs`) and the public schema's
   default grants give every client SELECT. Migration `20260927000005` revokes them from
   `anon`/`authenticated` and sets `security_invoker = on`. `v_top_topics` stays readable by
   signed-in parents for F10's topic chips, now with `fact_packs`' own `status='ready'`
   policy applied. RLS on a table does not protect a view over it.
2. **"Output tokens are ~70% of a story" is Sonnet-specific.** Measured from the §5 token
   table: 66% (Haiku 4.5) → 76% (Sonnet 5) → 84% (Opus 5.5) → 90% (Fable 5.1), because the
   input-heavy helper calls stay on Haiku whatever the writer is. The 70% figure is Sonnet's
   *write-call* output share. Anyone reasoning about cost per model should use
   `v_story_cost_by_writer` (measured tokens), not a share constant — Haiku 4.5's older
   tokenizer runs ~30% shorter for identical text.

Expected medians, derived from config and matching the brief: **$0.0445** Haiku 4.5 ·
**$0.0714** Sonnet 5 · **$0.1244** Opus 5.5 · **$0.2836** Fable 5.1. /admin flags a measured
median more than 35% off its writer's figure rather than shipping it quietly.

**Gates:** lint ✅ · typecheck ✅ · build ✅ · `pnpm test` → **161 passed, 12 skipped, 0
failed**. Integration VTs now also run in CI's `migrations` job (`pnpm test:int`), where a
database exists — the `check` job's placeholder keys skip them.

**Note for the lead:** `/api/quota` was not assigned to a lane. It is pure quota, so I built
it against `QuotaResponse`; move it if that collides with lane 4.

### 2026-09-27 — API outage, and lane 3 reviewed and merged

**An Anthropic API outage (ENOTFOUND) killed five of the six lanes mid-run.** Lane 3 had
already finished. No lane had committed anything, so all five had substantial uncommitted
work at risk. I resumed all five with an instruction to commit WIP as their first action
before continuing, so a second outage can't cost the work again.

**Lane 3 merged** (F8 6/6, F12 3/3) after review. I verified its two headline claims
myself rather than taking the report on trust:

1. **The view exposure was real, and it was my bug.** I recreated a view exactly the way my
   migration `20260927000003` creates one: it granted `SELECT` to `anon`, and an anonymous
   caller got real spend data back (`cost_usd: 0.000500`). **RLS on a table does not protect
   a SQL view over it** — the view is owned by `postgres` and bypasses it. All six cost views
   now return `42501 permission denied` to the anon key. `v_top_topics` stays readable by
   `authenticated` only, where `fact_packs`' own `status='ready'` policy applies.
2. **Quota atomicity holds under real concurrency.** 12 parallel connections against a limit
   of 3 → exactly 3 allowed, 9 denied, stored count exactly 3. (My first two probes were
   malformed — `(f()).*` calls a function once per output column, and a single-statement
   LATERAL shares one snapshot. Neither reflects production, which makes one call per
   request. Sequential separate statements: 3 allowed then denied, count holds at 3.)

**A hole in my Phase 0 CI, found by lane 3 and accepted:** the `check` job runs with
placeholder Supabase keys and no database, so **every integration VT silently skipped
there.** "Passes in CI" was not true for any of them. `pnpm test:int` now runs in the
`migrations` job, which has a real database.

**A bug of mine, found on merge:** `eslint.config.mjs` didn't ignore `.claude/`, so lint
walked into the five agent worktrees and reported **17,754 problems** belonging to other
lanes' in-flight branches. Fixed; `.claude/**` is ignored.

**Gates on `main`:** lint ✅ · typecheck ✅ · **161 tests pass, 0 fail** (was 98).
**API spend: $0.00** — still no model calls anywhere in the project.

**Outstanding hand-off for lane 2:** call `preflight()` before any model call and
`consumeQuota()` only after the `stories` row commits. Lane 3 shaped the API so it can't be
misused but cannot enforce the call site; F8's "quota consumed only on success" AC depends
on lane 2's call sites.

**Path collisions to resolve at merge:** lanes 2, 5 and 6 all created `prompts/`; lanes 2
and 6 both created `config/guardrails/`; lanes 1 and 6 both created `lib/guardrails/`; lanes
1, 3 and 4 all have `app/api/`. I've asked each lane to tell me which files are theirs
rather than coordinate directly.

**Two notes for later:** `lib/env.ts` validates `OWNER_USER_ID` with zod's `.uuid()`, which
rejects non-RFC-4122 UUIDs — a placeholder like `0000...0001` fails validation and 500s the
route; worth a line in `.env.example`. And lane 3 corrected my cost figure: output share of
total cost is 66% (Haiku) / 76% (Sonnet 5) / 84% (Opus 5.5) / 90% (Fable 5.1), because
input-heavy helper calls stay on Haiku whatever the writer is. My "~70%" was Sonnet's
write-call figure specifically.

### 2026-09-27 — lane 5 reviewed and merged

**F13 2/3 · F14 5/6.** Merged. What earned it: blindness is enforced in production rather
than only in tests — `assertBlind` runs on the assembled payload of every judge call and
throws, and the payload builders are the single place a request is constructed, so the tests
assert the object actually sent rather than a reconstruction. The injection test carries a
**positive control** proving it can fail, which is the part such tests usually omit. Cost
figures reconcile against `generation_logs` recomputed independently from the sink rows.

Three VTs are honest reds and stay red: the live calibration test is written and skipped, the
titanic `scary_level ≤ 1` AC reports UNVERIFIED (F7 must emit `scary_level` first), and the
mean-≥4.0 numbers cannot exist before F6 generates anything.

**Lane 5 found two real bugs in my `lib/reference.ts`.** `asStoryOutput()` dropped the cold
open — 110 words of the LEGO story, 251 of the shark story — so the judge would have scored
"Story craft" on a story beginning at Chapter 1. The part they didn't spot is worse: it also
deleted the shark story's opening continuity callback ("It had been a whole week since the
magic red brick had taken Cruz and Phoenix…"), which is precisely what rubric criterion 5
looks for in chapter 1. Calibration would have under-scored the stories it treats as the bar,
on two criteria at once. Fixing it surfaced a second bug: the subtitle was leaking into the
cold-open prose and into the word count. Both fixed, with five regression tests including one
asserting every second story carries a continuity callback from its prior bible.

Fixing it upstream then broke lane 5's local workaround, which double-folded the cold open
(2,102 words instead of 1,851, pushing the shark story out of band). I removed their fold,
moved `best_moment`/`worst_moment` onto `JudgeScore` in the shared contract, and rewrote the
one test that asserted the old broken state. All four references now validate against
`StoryOutput` and sit inside their band targets.

**Measured spend estimates, computed from `config/pricing.json`:** `pnpm eval` **$3.44** ·
calibration alone **$1.27** · bakeoff as specified **$54.79** · bakeoff at 2 samples with
Opus 5.5 judging **$20.36**. My $37–55 range was right; the top end is the spec as written.
Both CLIs refuse a live run above $20 without an explicit `--budget`.

**Gates on `main`:** lint ✅ · typecheck ✅ · **268 tests pass, 0 fail** (was 161).
**API spend: $0.00.**

**New blocker, affecting every lane:** there are no API credentials here —
`ANTHROPIC_API_KEY` is unset, `ant` is not installed, `api.anthropic.com` returns 401. Fixture
mode is the default so this blocks nothing already built, but it blocks every *live* VT:
judge calibration, `pnpm eval`, F5's live fact packs, F6's cache-read ratio, F15's nightly
live corpus, and the bake-off. Recorded as open question F.

### 2026-09-27 — lane 5 follow-up: one more defect, fixed

Lane 5 self-reported a defect in their own `lib/eval/synthetic.ts` after the merge and asked
whether it was worth fixing, noting the file may be deleted once F6 lands. Verified and fixed.

`fitToRange()` guarded chapter trimming at `> 4`, so `bees-band-a-5min` (650–850 words)
produced **4 chapters** — outside the 6–10 range §4.1.2 requires. 1 of 12 scenarios. No test
failed, because nothing validated a synthetic story's shape.

Fixed on the merits rather than deferred: a fixture generator that cannot produce a
schema-valid story means a scenario could fail the real gate for a reason the fixture
invented, and "the file might be deleted later" is not a reason to leave that in place. The
guard now stops at `STORY_MIN_CHAPTERS` and shortens chapter text instead of dropping a stop.
`bees-band-a-5min` is now 6 chapters at 848 words, inside its target; all 12 conform.

Added `test/unit/synthetic-scenarios.test.ts` — the assertion that was missing — covering all
12 scenarios for chapter count, band word target, non-empty chapters and determinism.

Also recorded a process point from lane 5 worth keeping (DECISIONS #59): §5's "fix the judge
prompt, never the references" has a third case — **fix the adapter**. With the cold-open bug
live, a correct judge would have marked the shark story's continuity down, and the rule as
written points at the judge prompt. Compensating there would have trained the judge to reward
a missing callback.

**Gates on `main`:** lint ✅ · typecheck ✅ · **274 tests pass, 0 fail**. API spend **$0.00**.

### 2026-09-27 — lane 6 reviewed and merged

**F15 6/10 VTs, and the four reds are honest.** Merged. I re-measured the corpus myself with
`pnpm guardrails:report` rather than taking the report on trust; every figure matched:

| Criterion | Target | Measured |
|---|---|---|
| Allow-set false refusal (L1) | ≤3% | **0/85 = 0.0%** |
| Refuse recall, L1 only | — | 109/136 = 80.1%; of the 109 marked `layer: L1`, **109/109** |
| Refuse recall, **L1+L2** | ≥99% | **UNVERIFIED — no API key** |
| Output hard-rule recall (deterministic) | 100% | **47/47**, all 14 rules, 3–4 excerpts each |
| Clean-set false positives | 0 | **0/24** |
| Reference stories through the output scan | 0 hard | **0 hard, 0 soft** on all four |

Corpus exceeds every §6 minimum: allow 85 (≥60), care 50 (≥30), refuse 136 (≥100, all seven
named vectors), outputs 47 breaching + 24 clean (≥60).

**The corpus caught two false positives against our own quality bar**, which is the direction
people forget to test:
1. The shark story ends a band A chapter `the whole ocean went **WHOOOOSH**...` — the §4.2
   cliffhanger check read that as dread. An ellipsis after an all-caps sound effect is now
   exempt, and the rule-3 violation it raises is soft.
2. Bare `blood` / `dead` / `shooting` as hard failures would have failed two references
   ("a tiny drop of blood", "people who liked shooting things", "back from the dead"). Hard
   checks are now violent phrases in context; bare words are soft hints to the reviewer.

Had those shipped, the gate would have rejected the stories that define what good looks like.

**An architectural overlap I need to settle when lane 1 lands.** I assigned the mechanical
sanitizer to lane 1 (F11) and lane 6 built one too — but theirs is not generic: it returns the
metadata L1 needs to decide a refusal (`removed.{html,control,zeroWidth,bidi}`, pre-collapse
`lineBreaks`, `truncated`) and enforces the §3.2 per-field caps. **Lane 6's version has to
win**, because a sanitizer that returns only a cleaned string silently deletes the
zero-width/bidi/markup refusals. Lane 1's F11 sanitizer should delegate to it rather than
duplicate it. Decided now so the merge isn't a coin flip.

**Blocked, and correctly reported as blocked:** the headline ≥99% refuse recall needs L2, and
27 of 136 refuse entries are semantic by design (franchise characters, a named classmate,
horror, subtle off-mission). `corpus-l2.test.ts` skips loudly and prints the cost of a
recording run — **$0.19 with caching, $0.36 worst case** — instead of reporting a number it
has not measured. Two further VTs wait on F8's `daily_usage` (lane 3, now merged) and F10's UI.

**Gates on `main`:** lint ✅ · typecheck ✅ · **401 tests pass, 0 fail** (was 274).
API spend **$0.00**.

### 2026-09-27 — lane 6 follow-up

Cherry-picked `6fa6185`: a code comment in `lib/guardrails/classify.ts` cited `DECISIONS.md
#35`, which the three-way renumber moved to #69. Lane 6 checked the merged file rather than
assuming the offset held, and flagged the commit rather than assuming I'd notice it landed
after the merge. Verified #69 is the structured-outputs row before picking it up.

**Recorded three notes from lane 6 as DECISIONS #72–74.** The one that matters is a trap
inside the sanitizer delegation I'd already decided: `sanitizeText()` *truncates* to the field
cap and sets `truncated: true`, while `checkField()` *refuses* on that flag. If lane 1's F11
path takes the truncated string and carries on, an over-cap topic becomes a **silently
shortened** topic instead of a kind "that's a bit long" message — and nothing fails, because
the string is valid. **To act on at lane 1's merge:** their sanitizer must consume the flag,
not just the string.
### 2026-09-27 — Phase 1, lane 1 (F2, F3, F11 server side)

**Delivered**

- **F2** — magic-link sign-in (`/login`) and Google OAuth wired behind
  `NEXT_PUBLIC_GOOGLE_OAUTH_ENABLED` (disabled in local config); `/auth/callback` handling
  both the PKCE `code` and `token_hash` branches; idempotent `ensureFamily`; `/settings`
  with display name and an IANA-validated timezone (auto-detected at login via a
  short-lived cookie, and once on the dashboard for a link opened elsewhere); account
  deletion as a single cascading `delete from families`.
- **F3** — `/api/children` CRUD with the 8-child ceiling and `ChildInput` validated on both
  client and server; `/children` UI with likes chips, notes, reading level, inline edit and
  delete.
- **F11 (server half)** — `lib/guardrails/sanitize.ts` (HTML, control, zero-width,
  whitespace, lengths per §3.2); IP rate limit 30/min in `proxy.ts`, ahead of auth; the
  privacy page; the closed-column-list schema assertion.
- Auth/route guards for pages and API routes in `proxy.ts` (`middleware.ts` renamed per
  Next 16).

**Two real bugs the e2e layer caught, both invisible to unit tests** — a session written by
a route handler was being discarded (`supabaseServer()` writes cookies through
`next/headers`, which does nothing when the handler returns its own `Response`), and
`request.nextUrl.origin` resolves to `localhost` whatever host was requested, so the browser
was redirected to a different cookie jar. See `DECISIONS.md` #33.

**Gates:** lint ✅ · typecheck ✅ · build ✅ · `pnpm test` → **254 passed, 12 skipped**
(from 98) · `pnpm test:e2e` → **36 passed**.

**CI changed** so these VTs actually run instead of skipping: the `migrations` job now also
runs `pnpm test` with the live database exported, and the `e2e` job starts Supabase and
installs WebKit (the `mobile` project is an iPhone 13 and could not launch a browser
before).

**API spend this session: $0.00.** No model calls — F2/F3/F11's server half touches no model.
### 2026-09-27 (cont.) — Phase 1, lane 2: the AI core (F4, F5, F6, F7)

**Delivered**
- `prompts/` — `master.v1.md` (the cached block, ~4.4k estimated tokens, all eight §4.1
  sections, three ≤120-word style anchors taken from the references), plus `normalize`,
  `factpack`, `factpack-review`, `bible-update`, `quality-review`, `repair`.
  `lib/prompts.ts` loads them by highest version and asserts the header matches the file.
- **F4** `lib/bible` — `childKey`/`getOrCreateSeries`/`loadBible`/`updateBibleFromStory`,
  LRU trimming to ≤800 tokens, optimistic concurrency on `version`, deterministic merge for
  conflicts, and a no-model fallback so continuity survives a dead helper model.
- **F5** `lib/topics` — `normalizeTopic`, the fact-pack builder (the only web-search step,
  tool type read from `config/models.json`), a free deterministic review before the Haiku
  one, the `building` lock on the unique `topic_key`, atomic `use_count`.
- **F6** `lib/generate` + `app/api/stories/generate/route.ts` — the prompt builder with one
  cache breakpoint, an incremental JSON scanner that emits SSE chapters as they stream,
  parse/repair, the two-shape failure contract, one writing-model call (two with a rewrite).
- **F7** `lib/quality` — 16 deterministic checks with stable reason codes, the output
  blocklist, the child-action heuristic, one Haiku review, and the
  rewrite → flagged → discarded ladder.

**Gates:** lint ✅ · typecheck ✅ · `pnpm test` → **276 passed, 12 skipped, 0 failed**
(17 files, up from 98 passed at the end of Phase 0). `pnpm test:blocked` → **16 red**, see
below.

**Eight defects the tests found and fixed** (detail in the commits): a shared retry budget
that silently dropped a bible update on a conflict; `use_count` losing increments under
concurrency; `prepareGeneration` letting a model outage escape as a 500; an NFKD bug that
would have split one fact pack into two for an accented topic; a truncated stream leaving a
chapter open forever; the cliffhanger check rejecting the shark reference; a `meta_content`
gap on the "ignore the rubric" family; a master prompt whose style anchors exceeded §4.1.8's
120-word cap.

**API spend this session: $0.00.** Not by choice — there is **no working
`ANTHROPIC_API_KEY`** in this environment (`.env.local` holds a 34-character placeholder;
no `ant` CLI, no `~/.config/anthropic`; a live call returns 401). So no fixture could be
recorded. Rather than fake them: the F6/F7 pipeline tests run against synthetic payloads in
the temp `FIXTURE_DIR` (which proves our plumbing and says so), and the four tests that need
real model judgement moved to `test/blocked/` with a README naming each VT and the ~$0.75
one-off recording cost. **Five VTs are therefore unverified, not green.**

### 2026-09-27 — all six lanes merged; live verification blocked on account credits

**Every lane is merged.** `main`: lint ✅ · typecheck ✅ · **890 tests pass, 0 fail**.

**API spend: $0.00.** Not by choice. The owner supplied a key and it authenticates —
`GET /v1/models` returns 200 with all 12 models, `claude-fable-5-1` among them, which
confirms the reference-story model is available as bake-off contestant 4. But **every
inference call returns HTTP 400: "Your credit balance is too low to access the Anthropic
API."** Confirmed account-wide with 1-token calls on both Haiku and Sonnet 5, so it is
billing and not a config or model-id problem.

The owner approved Opus 5.5 as the bake-off judge (DECISIONS #100) and I moved Fable 5.1 to
the second-judge slot so the strongest model still cross-checks the 12 decisive comparisons
(#101, +$1.81, flagged). Bake-off now estimates **$33.08**.

**Queued and ready to run the moment credits exist**, in this order — calibration first
because §5 gates everything judge-related:
| Step | Cost | Why it is first/blocked |
|---|---|---|
| Judge calibration (§5) | $0.51 | Gates every other judge number. Four sabotaged variants + the four references. |
| Guardrail L1+L2 corpus | $0.19 | The headline ≥99% refuse recall — currently the only unverified **safety** figure. |
| Lane 2 pipeline fixtures | $0.75 | Unblocks 5 VTs across F4/F5/F6. |
| `pnpm eval` (8 scenarios) | $3.44 | The ≥4.0 quality gate. |
| `pnpm bakeoff` | $33.08 | **Owner-approved.** Chooses the writing model. |

Worth noting the wrapper behaved correctly on the failure: it treated the 400 as
non-retryable rather than burning three attempts on a billing error, and logged it.

### 2026-09-28 — guardrail corpus measured live, and a dead test found

**The headline safety number is measured for the first time**, with 160 recorded
`classify_input` fixtures committed so CI replays it free:

| Criterion | Target | **Measured (Haiku 4.5)** |
|---|---|---|
| Refuse recall (L1+L2) | ≥99% | **100.0%** — 136/136, zero misses |
| Allow false-refusal | ≤3% | **1.2%** — 1/85 |
| Care-set age agreement | ≥90% | **90.0%** |
| Output hard-rule recall | 100% | 47/47, all 14 rules |
| Clean-set false positives | 0 | 0/24 |

**That test could never have passed.** `available` was set in `beforeAll` and read by
`describe.skipIf(!available)` — but vitest evaluates a `describe` modifier during
**collection**, before any hook runs, so the flag was always `false` at the moment it was
read. The four measurements were unreachable with a key, with fixtures, ever. It reported
itself as "skipped, needs an API key" while being unconditionally dead. Availability is now
decided synchronously at module load.

**Two bugs of mine in the same area**, both introduced when I split fabricated from recorded
fixtures:
1. `test/setup.ts` redirected `FIXTURE_DIR` to a temp dir for *every* run, so
   `pnpm guardrails:record` threw away the 160 fixtures it had just paid to record — it
   reported success in two seconds having persisted nothing. The redirect now applies only
   when not recording.
2. Replay looked *only* in the temp dir, so committed fixtures were invisible and the
   measurement skipped instead of replaying. My first fix — a read-through fallback to the
   committed directory — broke **38 tests**, because lane 5's judge helper works by
   *provoking* `MissingFixtureError` to learn the key it needs, and a fallback that finds a
   real fixture defeats that. The root is now resolved per call and a test file chooses which
   directory it wants; exactly one is live at a time.

Also raised `hookTimeout` for live runs (160 calls in one `beforeAll` does not fit in 60s,
and the timeout read as a classifier failure) and gave the corpus loop a 6-way pool.

**Gates:** lint ✅ · typecheck ✅ · **894 pass, 0 fail**, skips down from 15 to 11.
**Live spend to date: $3.30.**

This also establishes the **baseline Jev has to beat** (DECISIONS #106 condition 1): 100.0%
refuse recall and 1.2% false-refusal on the same 271-entry corpus.

### 2026-09-28 — judge calibration PASSES, 6/6

| Row | Result |
|---|---|
| references above floor | ✅ medians 4.65 / 4.50 / 4.25 / 4.25, mean 4.412 vs 4.37 baseline (drift 0.042) |
| `center ≤ 2` (Phoenix removed) | ✅ **center=1** |
| `facts ≤ 2` (3 invented dates) | ✅ named 3/3 unprompted |
| `age_fit ≤ 2` (band A chase) | ✅ **age_fit=1** |
| padding | ✅ delight **4→2** |
| pairwise, both orders | ✅ 0.95 / 0.95 |

Getting here took three owner decisions and one correction of my own:

1. **The owner rewrote §3** — criterion 1 became "Children at the center", scoring presence and
   agency rather than problem-solving, with a counting procedure and worked examples. That
   alone moved the references from a 3.95 mean to 4.55, sharks from 3.25 to 4.55. **My earlier
   claim that the references were flawed and the bar was wrong was mistaken**: I read the
   judge's faithful application of a bad rubric as evidence about the stories.
2. **Per-child counting** (owner-approved): the old rule marked a chapter if *any* named child
   acted, so with Cruz active throughout, the Phoenix-removed sabotage could not score below
   the silence cap's floor of 3 and §5's `≤2` was unreachable.
3. **Padding scored on delight, not age fit** (owner-approved): §3 already owns length
   mechanically, and this padding sits inside the tolerance.
4. **My own error, corrected**: I gated on "mean of medians ≥ 4.4" because one measurement read
   4.413 — and the next read 4.325 and failed. Exactly the fitted-threshold mistake I had
   argued against two decisions earlier. The floor now gates (4.0, principled, ~0.25 headroom)
   and the mean only reports against a baseline with a drift warning.

**Live spend: $10.84.** `main`: lint ✅ typecheck ✅ **894 pass, 0 fail.**

Next, in order: lane 2's pipeline fixtures ($0.75), `pnpm eval` ($3.44), `pnpm bakeoff` ($33.08,
owner-approved, Opus 5.5 judging with Fable 5.1 as second judge).
