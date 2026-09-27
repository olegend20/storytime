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
| F8 | Quotas and cost logging | 6 | 3 | 🟡 cost + freshness VTs green; quota/budget pending | 3 |
| F9 | Story library and reader | 4 | 0 | ⬜ not started | 4 |
| F10 | New-story flow (UI) | 5 | 0 | ⬜ not started | 4 |
| F11 | Safety, privacy and content policy | 5 | 0 | ⬜ not started | 1 + 4 |
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
