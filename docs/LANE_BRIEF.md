# Working agreements for every lane

Read this before starting. It is short on purpose; the detail is in the plan documents.

## Your sources of truth

1. `storytime-plan/IMPLEMENTATION_PLAN.md` — the sections your brief names, plus §3 (data
   model) and §4 (prompt architecture).
2. `storytime-plan/GUARDRAILS.md` — if you touch input, output, prompts or the gate.
3. `storytime-plan/agents/JUDGE_AGENT.md` — lane 5 only.
4. `storytime-plan/reference-stories/` — the quality bar. Lanes 2 and 5 must read all four
   stories fully before writing a prompt or a rubric. `manifest.json` carries each story's
   original request and prior bible. Parse them with `lib/reference.ts`, not your own parser.

On conflict: `GUARDRAILS.md` wins on safety, `IMPLEMENTATION_PLAN.md` wins on everything
else. If a document is silent, use judgment and add a line to `DECISIONS.md`.

## Hard rules

1. **Every model call goes through `lib/ai/callModel()` or `streamModel()`.** No direct
   `@anthropic-ai/sdk` import anywhere else. The wrapper owns logging, cost, retries,
   prompt caching and fixtures; bypassing it makes cost per story unknowable.
2. **`lib/schemas/` is the cross-lane contract.** Other lanes are building against it right
   now. Do not change, rename or widen a schema — **ask the lead.** Need a new shape? Ask.
3. **Model IDs and prices are config** (`config/models.json`, `config/pricing.json`). Never
   a literal in source. Never edit a price from memory; re-fetch the docs and cite the date.
4. **Tests replay fixtures by default.** `LIVE_API=1` only when deliberately recording.
   Record with `LIVE_API=1 RECORD_FIXTURES=1 pnpm test`. Never commit an API key.
5. **A feature is done only when every VT in its section passes.** Not "tests to follow".
6. **Never put a previous story's text into a generation prompt.** Series memory is the
   ≤800-token Story Bible plus the shared Fact Pack. This is the single most important
   constraint in the codebase — it is the entire reason the architecture looks like this.
7. **Children's data is minimal**: first name, age, likes, notes, reading level. Never add a
   field. RLS on every family-scoped table.

## Stop and ask the lead

Storing more about a child · loosening any guardrail rule or pass criterion · changing the
daily limit, budget cap or default length · picking the writing model · **any live API
spend beyond a handful of calls** (estimate from `config/pricing.json` first and say the
number) · a live failure suggesting the configured model IDs or prices are wrong.

## Shared local database — do not break other lanes

One local Supabase serves every lane concurrently.

- **Never `TRUNCATE`, never delete-all, never `supabase db reset`.** Other lanes are using
  the same rows.
- Create your own users/families per test with unique ids, and clean up only what you made.
- Local credentials (standard Supabase demo keys, safe to use locally):
  ```
  SUPABASE_URL=http://127.0.0.1:54321
  SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
  SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
  ```
- Need a schema change? **New migration file**, never an edit to an existing one — they are
  already applied in other lanes' databases.

## Process

- You are in your own git worktree on your own branch. Run `pnpm install` first.
- **One commit series per feature**, and report each feature separately so the lead can
  review it against its AC/VT list before merging.
- Before you report done: `pnpm lint && pnpm typecheck && pnpm test` must all pass.
- In your report, list **every VT for your features with its status** and name any you
  could not make pass and why. An honest red is worth more than an optimistic green.

## What Phase 0 already gives you

| Thing | Where |
|---|---|
| Model wrapper (+ streaming) | `lib/ai/callModel.ts`, `lib/ai/streamModel.ts` |
| Cost computation, role→model resolution | `lib/ai/pricing.ts` (`computeCost`, `modelForRole`) |
| Fixture record/replay | `lib/ai/fixtures.ts` |
| Log sink interface (`GenerationLogSink`) | `lib/ai/types.ts` — lane 3 supplies the Supabase one |
| All schemas | `lib/schemas/` |
| HTTP + SSE contract | `lib/schemas/api.ts` — owned by the lead, used by lanes 2 and 4 |
| Age bands, word targets, band helpers | `lib/schemas/common.ts` |
| Reference story parser | `lib/reference.ts` |
| Env validation | `lib/env.ts` |
| Supabase clients | `lib/supabase/{client,server,service}.ts` |
| Migrations (applied, RLS verified 16/16) | `supabase/migrations/` |
| Admin SQL views | `supabase/migrations/20260927000003_admin_views.sql` |

## Findings from the reference stories that affect prompts and gates

- The §4.4 output schema has **no cold-open field**, though §4.1.2 mandates a cold open.
  It folds into `chapters[0]` — which is exactly what the references do.
- **Ending style splits by band.** Band A closes with a direct bedtime address after
  "The End" (*"Goodnight, Milo. Goodnight, Juno. Play well."*); band C closes on a
  forward-looking beat (*"Tomorrow, he had a game to make."*). A goodnight address to a
  10-year-old reads as babyish. Choose per band.
- **Word count is narrative only** — cold open + chapter bodies + ending line. Raw counts
  run ~12% high.
- **Both band A references exceed the nominal 1,700-word ceiling** and pass only on the
  ±15% tolerance. The bar sits at the top of its band; do not write short to be safe.
- Legend hedging in the references reads exactly as §4.1.5 asks: *"That might be a bit of
  an exaggeration, but it tells you how crazy people were about it."*
- A factual mention of a branded character is allowed ("Mario started life as Jumpman");
  the character appearing as a participant is not (`GUARDRAILS.md` §4.1 rule 7).
