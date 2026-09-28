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

## 2026-09-27 — lane 4 (F9 reader/library, F10 new-story flow, F11 UI copy)

| # | Decision | Why |
|---|---|---|
| 26 | The UI's mock backend lives at **`/api/mock/*`**, not at `/api/*`, and 404s unless `UI_MOCK_API=1`. `NEXT_PUBLIC_API_MOCK=1` points the client at it. | Lane 2 owns `/api/stories/generate` and lane 1 owns `/api/children`; a mock at the real paths would collide on merge and could ship. One switch in `lib/client/api.ts` moves the whole UI between the two, so no component knows which is serving it. |
| 27 | The mock replays the **reference stories** (`lib/mock/fixture-stories.json`, generated by `pnpm fixtures:ui`), committed rather than read from `storytime-plan/` at runtime. | The reader had to be designed around real prose — a cold open, 7–10 chapters, sound words in caps, bolded facts, 8–14 true facts — not lorem ipsum. Committing the JSON keeps `storytime-plan/` out of the build graph, which `next.config.ts` deliberately excludes. |
| 28 | Fixture generation **folds a trailing coda into the previous chapter** when a reference parses to more than 10 sections. | DECISIONS #25: two references head their coda, so `parseReferenceStory` reports up to 12 while `StoryOutput` caps `chapters` at 10. The SSE `done` event carries a real `StoryOutput`, so a fixture that cannot satisfy the schema would be testing the wrong thing. Every word of prose is kept. |
| 29 | `LibraryStory` and `ChildrenResponse` in `lib/client/types.ts` are **provisional**, built by extending `StoryRecord` and `Child`. **Lead: please promote them into `lib/schemas/api.ts` or tell lane 4 the real shape.** | `api.ts` covers generate / quota / suggested topics but not `GET /api/stories` or `GET /api/children`, which F9's library and F10's chips both need. Extending the existing schemas avoids a parallel contract; no existing schema was changed. |
| 30 | Mock-only **sentinel topics** (`!refuse`, `!mature`, `!quota`, `!paused`, `!budget`, `!midfail`, `!unknownevent`, `!slow`) drive the failure paths, and `/api/mock/debug` exposes a `model_calls` counter. | Every F10 error state and F9's "zero model calls" AC then has an e2e test that *asserts* rather than assumes. A leading `!` is not something a parent types. Neither exists in lane 2's real route. |
| 31 | Reading mode and theme are expressed as **attributes on `<html>`, applied by an inline script before first paint**, with chrome hidden in CSS via `[data-chrome]`. | React state would flash the light theme and the full header for a frame on every reload — in a dark bedroom that flash is the whole problem. It also means no hydration mismatch, and `display: none` removes hidden chrome from the accessibility tree rather than leaving dimmed furniture for a screen reader to read out. |
| 32 | Reading mode **dims by lowering the page's own brightness and removing chrome**, never by lowering opacity on text. | Dimming text with `opacity` is the obvious implementation and it quietly breaks the contrast the axe scan checks. The dark + reading-mode combination gets its own a11y scan for the same reason. |
| 33 | Everything stored on the device goes through **`lib/client/localStore.ts` + `useSyncExternalStore`**, not `useEffect` + `setState`. | Two reasons, one of them a real bug: the React compiler lint rules forbid setState in an effect body, and — the bug — `/new` is statically prerendered, and React does not re-apply mismatched *attributes* during hydration, so a `useState(() => loadFormMemory())` initializer stored the remembered "15 min" correctly but rendered it unselected. `useSyncExternalStore` renders the server snapshot during hydration and then re-renders normally, which does patch the DOM. |
| 34 | On a **first visit every child is selected**, and tones default to **funny + exciting**. | Found by a failing e2e test: an empty selection left "Start the story" disabled with no explanation, spending a tap on a decision the parent had not asked to make. It is a safe default, not just a convenient one — §4.5 makes the *youngest* selected child set the vocabulary and peril, so including everybody can only make a story gentler. Together with the remembered length and the auto-focused topic field, reaching the topic costs zero taps (AC: ≤3). An empty remembered list always means "never submitted", since a submit requires ≥1 child, so this can never override a parent who narrowed the selection. |
| 35 | The suggested-topic row is **topped up from a local evergreen pool** when `GET /api/topics/suggested` returns fewer than 8. | "8 rotating chips" is an AC, and early in the product's life there are no fact packs, so the endpoint will return few or none. Server topics come first because `warm: true` means the story starts without a research call. This is also the 4 evergreen + 4 most-used split Appendix B3 chose. |
| 36 | The client-side input mirror (`lib/client/validate.ts`) implements the **shape rules of GUARDRAILS §3.2 only** — never the blocklist, never a safety verdict. | Shipping the blocklist to the browser publishes it, and a client-side safety verdict is a safety control an attacker can edit. The server and the L2 classifier stay authoritative; this only saves a parent from waiting on a request that was never going to work. |
| 37 | Refusal copy is rendered **verbatim** from the `error` event. The only UI-composed line is the quota reassurance, shown when `quota_consumed === false` and suppressed when the server message already says it. | `config/guardrails/messages.json` is lane 6's. F10 requires the parent to be told the attempt was free, and that is a quota statement rather than refusal copy — but saying it twice would read as nagging. `needsFreeRetryNote()` is unit-tested on both sides. |
| 38 | Story prose is tokenized to a data structure and rendered as **React elements** — never `dangerouslySetInnerHTML`. | A story is model output with parent-supplied names inside it. It does not get to inject markup, and a renderer that cannot inject markup needs no escaping audit. |
