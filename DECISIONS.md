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

## 2026-09-27 — after reading the reference stories

| # | Decision | Why |
|---|---|---|
| 18 | **The cold open is the opening of `chapters[0]`, not a separate field.** | §4.1.2 mandates a cold open in the child's real world, but the §4.4 output schema has no field for one. `IMPLEMENTATION_PLAN.md` wins on structure, so the schema stays exactly as written and the cold open lives inside the first chapter. The LEGO and shark references do precisely this (unheaded prose before "Chapter 1"). |
| 19 | **Ending style is band-dependent**, and the master prompt must choose per band. | The references use two conventions, split cleanly by band. Band A closes with a direct bedtime address after "The End" ("Goodnight, Cruz. Goodnight, Phoenix. Play well."); band C closes on a forward-looking final beat ("Tomorrow, he had a game to make.") with "The End" as a bare marker. A goodnight address to a 10-year-old would read as babyish. Encoded as `endingStyle` in `lib/reference.ts`. |
| 20 | Gate/judge word count counts **narrative only** — cold open + chapter bodies + ending line — confirmed empirically. | Raw file word counts run ~12% high (headings, True Facts list, markdown emphasis). Counting raw would flag the shark reference at 2,143 against band A's 1,955 tolerance ceiling; counting narrative puts it at 1,859, inside. This independently validates decision #9. |
| 21 | `lib/reference.ts` parses reference markdown into `StoryOutput`, shared by tests and `eval/`. | F7's VT runs the references through the deterministic gate and `JUDGE_AGENT.md` §5 scores them with their original requests. Both need one definition of "the story", not two parsers. |
| 22 | Reference `true_facts` get **synthetic** fact ids, and that limitation is stated in the code. | The references predate fact packs, so there is no real `fact_id` to map to. Fabricating ids that look real would let the `unsourced_fact` check appear to pass while testing nothing. |
| 23 | Eval scenarios use **Cruz 7, Phoenix 4**. | The manifest records the pair as "one of 4 and 7, which is which was not specified". F6's VT and §4.2's bible example both assign Cruz 7 / Phoenix 4, so the plan resolves the ambiguity. |
| 24 | Stories default to **American spelling**. | The manifest says so explicitly; references 1 and 3 use British spelling and must not be penalised for it. A note for the judge prompt, not a gate rule. |
| 25 | A headed cold open or coda means a reference may carry up to 12 headed markdown sections while `StoryOutput` caps `chapters` at 10. | Two references head their cold open ("Loading...", "Kickoff") and their return-home coda ("Game Over? Not Quite.", "Full Time"). Those are not journey stops, so the 6–10 rule in §4.1.2 is not breached. |

## 2026-09-27 — Phase 1, lane 2 (AI core: F4–F7 and prompts/)

| # | Decision | Why |
|---|---|---|
| 26 | Prompts are `prompts/<id>.v<N>.md` with front matter; `loadPrompt(id)` picks the highest N and asserts the header matches the filename | CLAUDE.md rule 5 wants a version header. Selecting by filename means bumping a prompt is a new file rather than an edit to a deployed one, and a version/filename mismatch throws instead of loading the wrong text. Front matter is stripped, so metadata edits cannot change the cached block's bytes. |
| 27 | `estimateTokens` is a local heuristic — `max(chars/3.6, words×1.35)` — not a `count_tokens` call | The bible size check runs on every load and must be free and synchronous. Calibrated to over-estimate slightly on JSON, so a bible that passes ≤800 locally cannot exceed it on the wire. Measured against the real count in the (blocked) cache test. |
| 28 | Helper calls ask for JSON in the prompt rather than using `output_config.format` structured outputs | One prompt shape works on every role including Haiku 4.5, where structured-output support is not stated in `config/models.json`. `callModel`'s `schema` already validates the parsed result, so the safety is the same and there is no 400 risk when the writing model is swapped by the bake-off. |
| 29 | A version conflict on the bible write is resolved by re-merging the **same** model proposal onto the fresh base, never by a second model call; and the model-attempt and write-attempt budgets are **separate** | The first version shared one 3-attempt budget, and a conflict on the final attempt silently dropped the whole update — the exact failure F4's concurrency VT exists to catch. Two phases: propose (3 model attempts, then a no-model fallback), then write (3 optimistic-concurrency attempts). |
| 30 | If the helper model fails all 3 attempts, `deterministicBibleUpdate` writes the topic, the ending and the writer's own `bible_suggestions` anyway | `last_story.ending` is what the next story's cold open is built from. Continuity must not depend on a helper model being alive. |
| 31 | The fact-pack build lock is the `fact_packs` row itself: the first writer to insert `status='building'` under the unique `topic_key` owns the build | No extra table, correct without a transaction, and survives a process restart — a `building` row older than 10 minutes may be taken over. A build that throws deletes its own row so the next request retries instead of polling a dead build. |
| 32 | `use_count` is incremented by an atomic SQL function (migration `20260927002001`), with a jittered compare-and-swap as fallback | Measured: 8 concurrent CAS callers landed only 5 increments. `use_count` feeds the §5 cache-hit-rate target and the F12 views, so a counter that silently under-reports makes that number meaningless. The fallback keeps generation working on a database that has not applied the migration. |
| 33 | A **rejected** fact pack raises on every later request rather than generating a story without facts | §4.3 makes the pack the only source of dates, names and numbers. Writing anyway would mean inventing them. The parent gets the friendly failure message and keeps their quota. |
| 34 | The rewrite call is **not** streamed | The client has already received attempt 1's chapters; replaying the same chapter indices would corrupt its concatenation. The rewritten story arrives in the `done` event, which already carries the authoritative story. |
| 35 | The pipeline is split into `prepareGeneration` (no bytes written yet → JSON + real HTTP status) and `runGeneration` (stream open → `error` event on a 200), with `SseChannel.waitForOpen()` as the pivot | `lib/schemas/api.ts` specifies exactly these two failure shapes. The split is the only way a model timeout can still be a 502 rather than a 200 carrying an error. |
| 36 | Any failure of the normalize or fact-pack step is a friendly 502 with the quota untouched, logged rather than rethrown | Previously only `TopicNormalizationError` / `FactPackRejectedError` were caught, so a Haiku outage or rate limit escaped as an unhandled 500. F6's AC is "failure modes return a friendly error and do not consume quota", which means all of them. |
| 37 | The deterministic cliffhanger check allows a trailing ellipsis **after a capitalised sound word** | GUARDRAILS §4.2 bans a chapter ending on a cliffhanger marker, but §4.1 rule 3 is about dread held over a break. The shark reference ends a chapter on "the whole ocean went **WHOOOOSH**..." — that is the quality bar, not a violation. "…and it was right behind him…" still fails. |
| 38 | The deterministic output blocklist excludes bare emotive words (`blood`, `dead`, `died`, `shot`, `shooting`, `war`, `scared`, `bite`, `burned`) | All nine appear legitimately in the reference stories ("a tiny drop of blood", "back from the dead", "one free shot"). A list that flagged them would reject the stories that define the bar. Nuance belongs to the L4 model review; the free layer catches only unambiguous terms and phrases. |
| 39 | `meta_content` is a phrase list, and the tests say so | It catches the common injection phrasings ("ignore the rubric", "as an AI") for free, and bare brand words are deliberately absent so "Claude Monet" is not flagged. A novel injection reaches the model layer by design — defense in depth, not a single barrier. |
| 40 | `child_has_action` is a name-then-action-verb heuristic over a ~230-verb lexicon with speech and thought verbs excluded, validated against all four references | It exists to catch the story where a child is pure audience, not to grade agency; the real judgement is the review pass's `kids_are_active_participants`. Every child in every reference passes, which is what keeps the lexicon honest. |
| 41 | A reference story is folded onto `StoryOutput` by prepending `coldOpen` to `chapters[0]` and merging headed cold opens/codas into their neighbours | Consequence of #18 and #25. The mapping is what a generated story would already have, so the four references can go through the F7 gate unchanged — which is how the blocklist, the action lexicon and the cliffhanger rule were empirically validated. |
| 42 | Quota is shaped as lane 3 named it — `preflight` / `quotaStatus` / `consumeQuota` — and lane 2 calls `preflight` before the first model call and `consumeQuota` only after the `stories` insert returns clean | F8's "quota is consumed only on a successful insert" cannot be enforced from lane 3's side; it is a property of these two call sites. Naming the interface after theirs makes the merge a wiring change rather than a translation layer. |
| 43 | `config/guardrails/messages.json` was created by lane 2 because the SSE `message` field needed parent-facing copy | GUARDRAILS §5 names the file and gives the templates verbatim. Lane 6 owns it; lane 2 seeded the four §5 templates plus the four codes `lib/schemas/api.ts` requires, and reads them through `lib/messages.ts` so refusal copy is never improvised inline. |
| 44 | Model responses in `test/int/pipeline.test.ts` are **synthetic** payloads in the temp `FIXTURE_DIR`, and the tests needing real model judgement are in `test/blocked/` | There is no API key in this environment (a 34-char placeholder in `.env.local`; live calls 401). Synthetic payloads prove our plumbing honestly; a synthetic fixture asserting "Haiku maps 'lego' to history-of-lego" would be a test of the test. See `test/blocked/README.md`. |
| 45 | Lane 2's migration is numbered `20260927002001`, not `…000005` | The shared local database already has a `20260927000005` applied from a lane whose file is not on this branch, so `supabase db push --local` refuses to run. Repairing the migration history would disturb that lane, so the function was applied directly to the local database and the file numbered into a lane-2 block. |


## Open — needs the owner

| # | Question | Default while waiting |
|---|---|---|
| B | **Phase 3 bake-off exceeds the $20 threshold**: ~$37 with Opus 5.5 as judge, ~$55 with Fable 5.1. | Will bring an exact figure computed from `config/pricing.json` plus a cheaper 2-sample variant before running anything. |
| C | `DAILY_BUDGET_USD` production value. | `5` in `.env.example`. |
| D | ~~Docker Desktop's VM disk full~~ | **Resolved 2026-09-27.** Owner approved `docker volume prune -f`; 46.34GB reclaimed, 890 anonymous volumes removed, both named `litellm-mvp-demo_*` volumes left intact. Migrations and RLS now verified against a real database. |
| E | ~~Reference stories missing~~ | **Resolved 2026-09-27.** Owner supplied `reference-stories.zip`: four stories plus a `manifest.json` carrying each story's original request and prior bible. Written by `claude-fable-5-1`, confirming bake-off contestant 4. |

## Appendix B defaults adopted (plan says do not block on these)

| Question | Default taken |
|---|---|
| B1 Tone list | funny, exciting, calm, mysterious, silly, heart-warming (enum in `lib/schemas/common.ts`, max 2 per story) |
| B2 Parent-editable Story Bible | v1.1, not v1. Not built; no flag needed yet. |
| B3 Suggested-topic chips | Both — 4 evergreen + 4 most-used fact packs |
