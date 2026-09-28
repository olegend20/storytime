# Progress

Feature status against `storytime-plan/IMPLEMENTATION_PLAN.md` §6. VT counts are the
verification tests named in each feature's section (plus `GUARDRAILS.md` §7 and
`JUDGE_AGENT.md` §7 where those sections delegate).

**A feature is done only when every VT in its section passes in CI.** No exceptions.

| F | Feature | VTs | Passing | Status | Lane |
|---|---|---|---|---|---|
| F1 | Project scaffold and infrastructure | 3 | 3 | ✅ **done** — env, migrations + introspection, CI all green | 0 lead |
| F2 | Authentication and family account | 4 | 0 | ⬜ not started — RLS isolation pre-verified (16/16 probe checks) | 1 |
| F3 | Children profiles | 3 | 1 | 🟡 schema VT green; API + e2e pending | 1 |
| F4 | Series and Story Bible service | 6 | 0 | ⬜ not started | 2 |
| F5 | Topic normalization and Fact Packs | 6 | 2 | 🟡 schema/review VTs green; service pending | 2 |
| F6 | Story generation pipeline | 7 | 1 | 🟡 `targetWords` VT green; pipeline pending | 2 |
| F7 | Quality gate | 5 | 0 | ⬜ not started | 2 |
| F8 | Quotas and cost logging | 6 | 6 | ✅ **done** — quota, tz boundary, cost, freshness, budget cap, failure logging | 3 |
| F9 | Story library and reader | 4 | 0 | ⬜ not started | 4 |
| F10 | New-story flow (UI) | 5 | 0 | ⬜ not started | 4 |
| F11 | Safety, privacy and content policy | 5 | 0 | ⬜ not started | 1 + 4 |
| F12 | Admin dashboard | 3 | 3 | ✅ **done** — owner gate 404s, view arithmetic, 80% hit rate | 3 |
| F13 | Quality evaluation harness | 3 | 2 | 🟡 merged; harness green in fixture mode. Live run blocked on F6 **and** on credentials | 5 |
| F14 | Model bake-off | 6 | 5 | 🟡 merged; 5/6. Live calibration VT written and skipped — needs credentials. **$54.79 run needs owner approval** | 5 |
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
