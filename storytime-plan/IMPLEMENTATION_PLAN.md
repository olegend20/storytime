# StoryTime — Implementation Plan & Verification Tests

> **For Claude Code.** This document is the source of truth for building StoryTime. It is written so that a lead agent can split the work into parallel lanes and hand each feature (F1–F13) to a sub-agent. Every feature has explicit acceptance criteria and verification tests. A feature is not done until its tests pass.
>
> Read `reference-stories/` before writing any prompt. Those four stories define the quality bar.
>
> Companion documents (also source of truth): `GUARDRAILS.md` (input/output content safety, F15) and `agents/JUDGE_AGENT.md` (quality judge and model bake-off, F13/F14).

---

## 0. Product summary

**What it is.** A free website where a parent registers, adds their children (first name, age, likes), and each night generates a personalized, read-aloud story on any topic the kids choose ("the history of LEGO", "sharks", "how volcanoes work"). The children are the stars of the story. Each story ends with a "True facts" section. Stories form an ongoing series per group of children: recurring characters, callbacks and running jokes carry over from night to night.

**Who pays.** The owner (Dave) pays all inference costs. The product is free to parents. Therefore **cost per story is a first-class design constraint**, equal in priority to story quality.

**Decisions already made**
| Decision | Value |
|---|---|
| Stack | Next.js (App Router, TypeScript) on Vercel; Supabase (Auth, Postgres, RLS, Edge Functions optional) |
| Free-tier limit | 3 new stories per family per calendar day (family local time) |
| Illustrations | None at launch. Text only. |
| Story length | Parent picks 5 / 10 / 15 minutes. Default 10. |
| Writing model | **Decided by the bake-off (F14)** between Haiku, Sonnet, Opus and the model that wrote the reference stories. Build with Sonnet as the placeholder default; the model ID must be a single config value so it can be swapped without code changes. Helper tasks: current Haiku. **Verify current model IDs and pricing at https://docs.claude.com before hard-coding.** |
| Content safety | Four-layer guardrails on input and output per `GUARDRAILS.md`. Non-negotiable; blocks merge on regression. |

**Non-goals for v1**
- No images, audio narration, or PDF export.
- No sharing stories between families, no social features.
- No mobile app (the site must be fully usable on a phone browser).
- No payments.

---

## 1. Design principles (why the architecture looks like this)

1. **Never reload history.** In the chat that produced the reference stories, each new chapter had ~15,000 words of previous chapters in context. That is what we are designing out. The system remembers a series through a compact **Story Bible** (≤ 800 tokens), not through transcripts.
2. **Research once, reuse forever.** Facts about a topic are the same for every family. **Topic Fact Packs** are built once per topic (the only step that may use web search) and shared globally. Research cost scales with the number of *topics*, not the number of *families*.
3. **Cache the expensive static prompt.** The master system prompt is large and identical for every call. Use Anthropic prompt caching so it is billed at the cached rate.
4. **One expensive call per story.** Exactly one call to the writing model per story (plus at most one regeneration on quality failure). Everything else (normalization, bible updates, quality gate) uses the cheap model.
5. **Cap the worst case.** Daily per-family limits bound the cost regardless of user count.
6. **Measure everything.** Every model call logs tokens, cache hits, latency and computed cost, so cost per story is known from day one.
7. **Quality is checked, not assumed.** A quality gate validates every story against the requested age band, length, names and safety rules before the parent sees it.

---

## 2. Architecture overview

```
Browser (Next.js app)
   │  Supabase Auth (magic link + Google)
   │
   ▼
Next.js Route Handlers / Server Actions (Vercel)
   ├── /api/stories/generate  (streaming SSE)
   ├── /api/children, /api/families, /api/stories, /api/series
   │
   ├── lib/topics      → normalize topic (Haiku) → find/create Fact Pack
   ├── lib/bible       → load Story Bible, apply updates (Haiku)
   ├── lib/generate    → build prompt (cached master + bible + fact pack + request)
   │                     → stream Sonnet → parse structured JSON
   ├── lib/quality     → quality gate (deterministic checks + Haiku review)
   ├── lib/limits      → daily quota
   └── lib/costs       → per-call cost logging
   │
   ▼
Supabase Postgres (RLS on every table)
   families · children · series · story_bibles · stories · fact_packs · generation_logs · daily_usage
```

**Generation sequence (one night):**
1. Parent selects children, enters topic, picks tone(s) and length.
2. Server checks quota → 429 if exceeded.
3. Normalize topic → `topic_key` (Haiku, ~100 tokens).
4. Fact Pack: lookup by `topic_key`. On miss, build it (Sonnet + web search tool), store it. On hit, reuse.
5. Load Story Bible for this exact set of children (create empty if first time).
6. Build prompt: `[cached master prompt] + [bible] + [fact pack] + [request]`.
7. Stream writing-model response to client as Server-Sent Events; render chapters progressively.
8. On completion, parse structured output → run quality gate. On fail, one regeneration with the failure reasons appended. On second fail, return the story flagged with a "we're not sure this one is perfect" banner (never a blank screen).
9. Save story. Enqueue background bible update (Haiku). Log costs.

---

## 3. Data model

All tables have `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at`. RLS: a row is visible only where `family_id = auth.uid()`-owned family, except `fact_packs` (read-only for all authenticated users, write only via service role) and `generation_logs` (service role only).

```sql
families (
  id, owner_user_id uuid references auth.users, display_name text,
  timezone text not null default 'UTC',
  deleted_at timestamptz null
)

children (
  id, family_id, first_name text not null (max 30 chars),
  age int not null check (age between 1 and 17),
  likes text[] default '{}',           -- short tags, max 10, each ≤ 40 chars
  notes text null (max 300),           -- free text from parent, e.g. "loves goalkeeping"
  reading_level text null              -- optional override: 'younger' | 'typical' | 'older'
)

series (
  id, family_id,
  child_ids uuid[] not null,           -- sorted; a series is keyed by the exact set of children
  child_key text not null,             -- deterministic hash of sorted child_ids (unique per family)
  title text null,                     -- optional parent-chosen series name
  unique (family_id, child_key)
)

story_bibles (
  id, series_id unique, family_id,
  version int not null default 1,
  content jsonb not null,              -- see §4.2 schema
  token_estimate int not null
)

stories (
  id, family_id, series_id,
  topic_input text not null,           -- what the parent typed
  topic_key text not null,             -- normalized
  fact_pack_id uuid null,
  tones text[] not null,               -- e.g. {'funny','exciting'}
  length_minutes int not null check (length_minutes in (5,10,15)),
  age_band text not null,              -- computed from youngest selected child
  title text not null,
  content jsonb not null,              -- see §4.4 story schema
  word_count int not null,
  quality jsonb not null,              -- gate results
  status text not null default 'ready' -- 'ready' | 'flagged' | 'failed'
)

fact_packs (
  id, topic_key text unique not null,
  topic_label text not null,           -- human readable
  content jsonb not null,              -- see §4.3 schema
  sources jsonb not null,              -- [{title,url}]
  model text not null, version int default 1,
  use_count int default 0,
  quality_score numeric null,          -- from review step
  status text default 'ready'          -- 'ready' | 'building' | 'rejected'
)

generation_logs (
  id, family_id null, story_id null, fact_pack_id null,
  purpose text not null,               -- 'normalize'|'factpack'|'write'|'rewrite'|'quality'|'bible_update'
  model text not null,
  input_tokens int, cache_read_tokens int, cache_write_tokens int, output_tokens int,
  cost_usd numeric(10,6) not null,
  latency_ms int, ok boolean, error text null
)

daily_usage (
  family_id, usage_date date, count int default 0,
  primary key (family_id, usage_date)
)
```

**Why a series is keyed by the exact set of children:** "Milo + Juno" and "Theo" are different series with different recurring characters (the magic brick vs. Bit). "Milo + Juno + Theo" would be a third series. This matches how the reference stories worked.

---

## 4. Prompt architecture

### 4.1 Master system prompt (cached)
One static block, ~3,000–5,000 tokens, identical for every story call. Marked with `cache_control` so it is billed at the cached rate after the first use. Contents:

1. **Role & mission**: write read-aloud bedtime stories in which the named children are the heroes of a true-history / true-facts adventure.
2. **Structure template** (learned from the reference stories):
   - Cold open in the child's real world (bedroom, backyard) → a magical device or guide pulls them into the topic → 6–10 short chapters, each a "stop" on the journey with a mini-challenge the kids solve → return home with a small keepsake or message → "The End" line → **"True facts from the story"** list (8–14 bullets).
   - Every chapter has a hook, a fact, and a moment where the child *does* something (not just watches).
   - Shout-along lines for younger kids ("CLICK!", "PLAY WELL!").
3. **Age-band rules** (see §4.5): vocabulary, sentence length, peril level, humour style, word count per minute.
4. **Series continuity rules**: use the Story Bible; reuse recurring characters/devices when present; add at most one new recurring element per story; reference the previous story's ending in the cold open; never contradict the bible.
5. **Fact handling rules**: use only facts from the Fact Pack or well-established general knowledge; if a fact is a popular legend, say so in-story ("that might be a bit of an exaggeration"); never invent dates, names or numbers; the True Facts list must only contain items present in the fact pack.
6. **Safety rules**: no graphic violence, death handled gently and only when the topic requires it, no romance, no real living private individuals, no brand mascots/characters beyond factual history unless the parent asked for that character by name (GUARDRAILS.md §3.3 and §4.1 rule 7), no scary cliffhangers at bedtime, upbeat ending always.
7. **Output contract**: respond with JSON only, matching the story schema (§4.4). No prose outside the JSON.
8. **Style anchors**: 3 short excerpts (≤ 120 words each) from the reference stories showing (a) a younger-kids chapter, (b) an older-kid chapter, (c) a True Facts list. Excerpts only; do not include full stories.

### 4.2 Story Bible schema (per series, ≤ 800 tokens)
```json
{
  "children": [
    {"name": "Milo", "age": 7, "likes": ["LEGO", "sharks"], "role_notes": "often the one with the idea"},
    {"name": "Juno", "age": 4, "likes": ["dinosaurs"], "role_notes": "gets the shout-along lines"}
  ],
  "recurring": [
    {"name": "The magic red LEGO brick", "type": "device", "rule": "glows and clicks to start an adventure; returns them home at the end"},
    {"name": "Grandpa Greenie", "type": "character", "rule": "400-year-old Greenland shark guide; slow, kind, jokes about being old"}
  ],
  "catchphrases": ["Play well", "WHOOOOSH"],
  "topics_covered": [{"topic": "history of LEGO", "story_id": "...", "date": "2026-09-25"}, {"topic": "sharks", "story_id": "...", "date": "2026-09-26"}],
  "last_story": {"title": "Milo, Juno and the Shark Submarine", "ending": "A shark tooth appeared on the bedroom floor; they whispered goodnight to Grandpa Greenie."},
  "tone_history": ["funny", "exciting"],
  "avoid": ["repeating the submarine device two nights in a row"]
}
```
**Bible update rule:** after each story, Haiku receives *the old bible + the new story* and returns *the new bible*. It must stay under 800 tokens; `topics_covered` keeps the last 20; `recurring` keeps at most 8 (drop least-recently-used). The update is a single atomic write with `version + 1`.

### 4.3 Fact Pack schema (per topic, shared)
```json
{
  "topic_key": "history-of-lego",
  "topic_label": "The history of LEGO",
  "summary": "2–3 sentences",
  "facts": [
    {"id": "f1", "text": "LEGO was founded in Billund, Denmark, by carpenter Ole Kirk Christiansen, who began making wooden toys in 1932.", "kid_safe": true, "min_age": 3, "confidence": "high", "source_ids": ["s1"]},
    {"id": "f2", "text": "The name comes from the Danish 'leg godt', meaning 'play well'.", "kid_safe": true, "min_age": 3, "confidence": "high", "source_ids": ["s1","s2"]},
    {"id": "f9", "text": "A popular story says Japan ran short of coins because of Space Invaders; this is likely exaggerated.", "kid_safe": true, "min_age": 8, "confidence": "legend", "source_ids": ["s4"]}
  ],
  "timeline": [{"year": 1932, "event": "..."}],
  "characters": [{"name": "Ole Kirk Christiansen", "role": "founder", "kid_friendly_note": "kind carpenter who never gave up"}],
  "sensitive_notes": "The 1942 fire: handle gently, nobody hurt.",
  "sources": [{"id": "s1", "title": "...", "url": "..."}]
}
```
**Building a fact pack** runs once per topic. *Owner decision 2026-09-29 (DECISIONS #139):* the pack is written from the model's own knowledge first — a children's story does not need a web source behind every fact — and the web search tool is used only when the model reports it does not know the topic. A Haiku review pass rejects packs with fewer than 12 facts, any cited source that does not exist, or any `kid_safe: false` item without a `sensitive_notes` entry. Target 20–30 facts. Cap total pack size at ~2,000 tokens.

**Topic normalization** (Haiku): maps free text to a stable `topic_key`. "how lego was invented", "History of Lego", "lego bricks story" → `history-of-lego`. "sharks" and "different kinds of sharks" → `sharks`. The prompt returns `{topic_key, topic_label, is_appropriate_for_children: bool, reason}`. Inappropriate topics are refused with a friendly message before any expensive call.

### 4.4 Story output schema (from the writing model)
```json
{
  "title": "Milo, Juno and the Shark Submarine",
  "subtitle": "The next adventure of the magic LEGO brick",
  "chapters": [
    {"heading": "Chapter 1: Grandpa Greenie", "text": "markdown body", "shout_line": "WHOOOOSH!"}
  ],
  "ending_line": "Goodnight, Milo. Goodnight, Juno. Swim well.",
  "true_facts": [{"text": "...", "fact_id": "f1"}],
  "bible_suggestions": {
    "new_recurring": [{"name": "Grandpa Greenie", "type": "character", "rule": "..."}],
    "ending_summary": "one sentence"
  },
  "estimated_read_minutes": 10
}
```
Parse with a schema validator (zod). If the model returns non-JSON, one repair attempt with Haiku ("convert this to the schema"); if that fails, treat as generation failure.

### 4.5 Age bands and length targets
| Band | Ages | Words per 10 min | Sentence style | Peril level | Humour |
|---|---|---|---|---|---|
| A | 3–5 | 1,300–1,700 | short, repetition, sound words | none; nothing chases anyone | silly, physical |
| B | 6–8 | 1,600–2,200 | medium; a few "big words" explained in-story | mild, resolved within the chapter | silly + wordplay |
| C | 9–12 | 2,200–3,200 | longer, wit, in-jokes, some sarcasm | moderate, stakes but nobody hurt | dry, self-aware |
| D | 13+ | 2,800–3,800 | near-adult | moderate | dry |

**Mixed ages:** vocabulary and peril follow the *youngest* selected child's band; include at least one "big kid" hook per chapter (a surprising fact, a decision, a joke aimed up). 5-minute and 15-minute targets scale linearly.

---

## 5. Cost model

Log every call. Compute `cost_usd` from the live price table (store prices in `config/pricing.json`, updated by hand; add a test that fails if the file is older than 90 days).

Per story, expected calls:
| Step | Model | Approx tokens | Notes |
|---|---|---|---|
| normalize | Haiku | 300 in / 50 out | |
| fact pack | Sonnet + search | one-time per topic | amortized to near zero as library grows |
| write | Sonnet | ~4k cached in + ~1.5k uncached in / 4–6k out | the cost that matters |
| quality | Haiku | ~6k in / 200 out | |
| bible update | Haiku | ~7k in / 600 out | background |

**Targets:** median cost per story ≤ the equivalent of a few US cents; fact-pack cache hit rate ≥ 80% after 500 stories; writing-model cache read rate ≥ 90% of master-prompt tokens. Build an admin page (F12) that shows these live.

---

## 6. Features, acceptance criteria and verification tests

Notation: **AC** = acceptance criteria, **VT** = verification tests. Test layers: `unit` (Vitest), `int` (integration against a local Supabase), `e2e` (Playwright), `eval` (model-output evaluation; see F13). Model-calling tests must run against recorded fixtures by default and against the live API only when `LIVE_API=1`.

---

### F1 — Project scaffold and infrastructure
**Scope:** Next.js 15+ App Router, TypeScript strict, Tailwind, Supabase client + server helpers, env validation, CI (GitHub Actions: lint, typecheck, unit, int), Vercel project, Supabase migrations folder, seed script.
**AC**
- `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm test:e2e` all work from a clean clone with `.env.example` copied.
- Missing env vars fail fast with a clear message.
- Migrations apply cleanly to a fresh Supabase project.
**VT**
- unit: env schema rejects missing `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- int: `supabase db reset` then `pnpm migrate` produces all tables in §3 with expected columns (introspection test).
- CI: pipeline green on a PR that changes nothing.

### F2 — Authentication and family account
**Scope:** Supabase Auth with email magic link and Google OAuth. On first login create a `families` row. Family settings page: display name, timezone (auto-detected, editable). Account deletion (hard-deletes children, series, bibles, stories; keeps anonymized generation_logs).
**AC**
- Unauthenticated users can only see the landing page and login.
- One family per user; re-login never creates a second family.
- Delete account removes all family-scoped rows within one transaction.
**VT**
- e2e: magic-link login flow with Supabase's local inbucket; lands on dashboard.
- int: logging in twice creates exactly one `families` row.
- int: RLS — user A cannot `select` user B's children/stories/series/bibles via the anon client (expect 0 rows, not an error).
- int: delete account → counts of children/series/stories/bibles for that family are 0; `generation_logs.family_id` is null for those rows.

### F3 — Children profiles
**Scope:** CRUD for children. Form: first name, age, up to 10 "likes" chips, optional notes (≤300 chars), optional reading-level override. Max 8 children per family.
**AC**
- Validation on client and server (name 1–30 chars, age 1–17, likes ≤10, notes ≤300).
- Editing age later does not break existing series; the bible is refreshed on next generation.
**VT**
- unit: zod schema accepts valid child; rejects age 0, 18, name of 31 chars, 11 likes.
- int: creating a 9th child returns 400 with a friendly message.
- e2e: add two children, see both in the picker, edit one, delete one, confirm list.

### F4 — Series and Story Bible service
**Scope:** `lib/bible`: `getOrCreateSeries(familyId, childIds)`, `loadBible(seriesId)`, `updateBibleFromStory(seriesId, story)` (Haiku), token estimation, size enforcement, optimistic concurrency via `version`.
**AC**
- Series is keyed by the sorted set of child ids; same set → same series.
- New series bible is built from child profiles only (no recurring characters yet).
- After a story, the bible contains: the new topic in `topics_covered`, `last_story.ending`, any `new_recurring` from `bible_suggestions` (max 8 kept), and stays ≤ 800 tokens.
- Bible update runs in the background (does not block the response) and is retried up to 3 times.
- Editing a child's age/likes propagates to the bible on next load.
**VT**
- unit: `childKey([b,a]) === childKey([a,b])`.
- unit: `enforceBibleLimits` trims `topics_covered` to 20 and `recurring` to 8 (LRU) and result ≤ 800 tokens (using the tokenizer estimate).
- int: generate story 1 then story 2 for same children → `stories[1].series_id === stories[0].series_id`; bible `version` increments by 1 per story.
- int (fixture): given old bible + reference story "Shark Submarine", the Haiku update output includes a recurring entry whose name contains "Greenie" and `last_story.ending` mentions a tooth.
- int: two concurrent updates with the same `version` → exactly one succeeds, the other retries and succeeds with merged content.
- eval (F13): continuity test — a third story for Milo+Juno references the brick or a prior recurring element in its first chapter.

### F5 — Topic normalization and Fact Packs
**Scope:** `lib/topics`: `normalizeTopic(text)` (Haiku, structured), `getOrBuildFactPack(topicKey)` with a `building` lock to prevent duplicate builds, fact pack builder (writing model + web search tool), Haiku review pass, `use_count` increment.
**AC**
- Synonymous inputs map to the same `topic_key` (see examples in §4.3).
- Inappropriate topics (`is_appropriate_for_children: false`) are rejected before any fact-pack or story call with a friendly message; nothing is stored except a log entry.
- A fact pack is built at most once per key even under concurrent requests.
- A pack has 12–40 facts, size ≤ 2,000 tokens, and `confidence` set; a researched pack's facts cite sources that exist (knowledge packs have none — DECISIONS #139).
- Second and later requests for a topic make zero search calls.
**VT**
- int (fixture): `normalizeTopic` for the 6 inputs ["how lego was invented", "History of Lego", "lego", "sharks", "different shark species", "the history of soccer"] → keys `history-of-lego` ×3, `sharks` ×2, `history-of-soccer`.
- int (fixture): `normalizeTopic("how to make a weapon")` → `is_appropriate_for_children: false`; API returns 422; no `fact_packs` row created.
- int: fire 5 concurrent `getOrBuildFactPack("history-of-lego")` → exactly one `generation_logs` row with purpose `factpack`; 5 identical results.
- unit: review pass rejects a pack with 11 facts, or a fact with empty `source_ids`.
- int (LIVE_API): build packs for `history-of-lego`, `sharks`, `history-of-soccer`, `history-of-video-games`; each has ≥ 15 facts and includes at least 3 of the "anchor facts" listed in `reference-stories/` True Facts sections (e.g. "leg godt", "1958 patent", "William McCrum", "Pickles").
- int: after 2 generations on the same topic, `use_count === 2` and only one `factpack` log row exists.

### F6 — Story generation pipeline (the core)
**Scope:** `lib/generate`: prompt builder (master cached block + bible + fact pack + request), streaming call to the writing model, SSE route `/api/stories/generate`, JSON parsing/repair, save to `stories`, trigger bible update and quality gate. Request block includes: children (name, age, likes, notes), age band, tones, length target in words, topic label, "do not repeat" list from bible.
**AC**
- Exactly one writing-model call per story on the happy path; at most two when the quality gate requests a rewrite.
- Master prompt is sent with `cache_control`; after warm-up, `cache_read_tokens` ≥ 90% of the master prompt size on every write call.
- Streaming: the client receives the title within 5 s of request and chapters progressively; total generation ≤ 90 s p95 for a 10-minute story.
- Output validates against §4.4; word count within the band's range for the requested minutes (±15%).
- Every child selected appears by name in ≥ 60% of chapters and has at least one action (verified in the quality gate).
- Failure modes return a friendly error and do not consume quota.
**VT**
- unit: `buildPrompt` places the master block first with `cache_control`, then bible, fact pack, request; snapshot test of the assembled messages for a fixed input.
- unit: `targetWords({band:'A', minutes:10})` → within 1,300–1,700; `band C` → 2,200–3,200; 5 min halves it.
- unit: parser accepts a valid story JSON, rejects one missing `true_facts`, repairs a JSON wrapped in ```json fences.
- int (fixture): full pipeline with recorded model responses → `stories` row saved with `word_count`, `status='ready'`, `quality` populated; exactly one `write` log row.
- int (fixture): simulated model timeout → response 502, no `stories` row, `daily_usage` unchanged.
- int (LIVE_API): generate one story for children `[{Milo,7},{Juno,4}]` on `sharks`; on the second call the `cache_read_tokens` ≥ 0.9 × master prompt tokens.
- e2e: request a story and assert the first chapter renders before the SSE stream closes (progressive rendering).

### F7 — Quality gate
**Scope:** `lib/quality`: deterministic checks + one Haiku review. Deterministic: schema valid; word count in range; every selected child's name present; name appears in ≥ 60% of chapters; ≥ 8 true facts and each maps to a fact-pack `fact_id`; ending line present; banned-word list clean; no chapter > 40% of total words. Haiku review (structured): `age_appropriate`, `scary_level (0–3)`, `kids_are_active_participants`, `facts_consistent_with_pack`, `tone_matches_request`, `reasons[]`. Fail → one rewrite with reasons appended to the request. Second fail → `status='flagged'`, story still shown with a soft banner.
**AC**
- Gate runs on every story; results stored in `stories.quality`.
- Deterministic checks run before any model call; a deterministic failure skips the Haiku review.
- Total gate latency ≤ 8 s p95.
**VT**
- unit: each deterministic check has a passing and failing fixture (e.g. story with Juno missing → fail with reason `child_missing:Juno`).
- unit: a true fact whose `fact_id` is not in the pack → fail `unsourced_fact`.
- int (fixture): Haiku review returns `scary_level: 3` for band A → rewrite is triggered and the rewrite request contains the reasons text.
- int (fixture): two consecutive failures → `status='flagged'`, story visible, banner rendered (e2e).
- eval (F13): the four reference stories pass the deterministic gate when run with their original inputs.

### F8 — Quotas and cost logging
**Scope:** `lib/limits` (3/day per family, day boundary = family timezone, atomic increment with `insert ... on conflict`), `lib/costs` (price table, cost computation, logging wrapper around every Anthropic call), global kill-switch env `GENERATION_ENABLED`, global daily budget cap env `DAILY_BUDGET_USD` that disables generation when exceeded.
**AC**
- The 4th generation in a day returns 429 with the local reset time.
- Quota is only consumed on a successful `stories` insert (failures and refusals are free).
- Every model call has a `generation_logs` row with a non-null cost, including failures.
- Kill switch and budget cap take effect without a deploy.
**VT**
- int: 3 successful generations then a 4th → 429; `daily_usage.count === 3`.
- int: quota uses family timezone — a family in `Pacific/Auckland` at 23:30 local and another in `America/Los_Angeles` get different `usage_date`s for the same UTC instant.
- unit: `computeCost({model, input, cacheRead, cacheWrite, output})` matches hand-computed values from `config/pricing.json` for three cases.
- unit: pricing file `updated_at` older than 90 days fails the test suite with a message to refresh it.
- int: set `DAILY_BUDGET_USD=0.01`, generate once → subsequent request returns 503 "paused for today".
- int: failed generation (fixture timeout) still writes a log row with `ok=false`.

### F9 — Story library and reader
**Scope:** Library page (grouped by series, newest first), story reader page (large readable type, chapter navigation, "reading mode" that dims UI and enlarges text, night-friendly dark theme, remembers scroll position per story in localStorage), True Facts section rendered as a checklist, "Read again" is free (no model calls), delete story.
**AC**
- Reader works on a 375 px wide phone with no horizontal scroll.
- Opening a saved story makes zero model calls.
- Deleting a story removes it from the library; the bible is not rolled back (documented behaviour).
**VT**
- e2e: generate one story (fixture mode), navigate to library, open it, confirm all chapters and the facts list render; `generation_logs` count unchanged by the open.
- e2e (mobile viewport 375×812): no element wider than viewport; chapter nav usable.
- e2e: reload mid-story restores scroll position within 200 px.
- int: delete story → 404 on its URL; other stories in the series intact.

### F10 — New-story flow (UI)
**Scope:** The nightly form: pick one or more children (chips), topic text input with 8 suggested chips (rotating, from the most-used fact packs plus evergreen ideas), tones multi-select (funny, exciting, calm/sleepy, mysterious, silly, heart-warming; max 2), length (5/10/15), "Start the story" button, quota indicator ("2 of 3 stories left today"), streaming reader with a subtle progress indicator, friendly error states (inappropriate topic, quota, service paused, generation failed with "try again — this didn't use one of your stories").
**AC**
- Whole flow takes ≤ 3 taps before typing the topic on a phone.
- Form remembers the last-used children and length.
- Inappropriate-topic and quota messages are kind and specific.
**VT**
- e2e: happy path with fixtures → story renders progressively; quota indicator decrements.
- e2e: selecting 3 tones is prevented (max 2).
- e2e: fixture returning `is_appropriate_for_children:false` → inline message, no navigation away, quota unchanged.
- e2e: after quota is exhausted, the button is disabled with the reset time shown.
- a11y: axe-core scan of the form and reader pages reports no serious violations.

### F11 — Safety, privacy and content policy
**Scope:** Privacy page and in-app copy (first names only, no photos, parent-owned account, one-click delete); server-side input sanitization (strip HTML, cap lengths); master-prompt safety rules; banned-topic list in normalization; rate limit on the API by IP (Vercel/Upstash) to stop abuse of the free tier; no third-party analytics that collect children's data (use privacy-respecting page-view counts only).
**AC**
- Children's records contain only: first name, age, likes, notes, reading level. No birthdate, no last name field exists.
- Every page that shows child data is behind auth.
- API rejects payloads with HTML/script content in text fields.
**VT**
- unit: sanitizer strips `<script>` and trims to limits.
- int: `children` table has no `last_name`/`birthdate` column (schema assertion).
- int (fixture): 10 topic strings from a "must refuse" list (weapons, adult themes, self-harm, real private people) → all return 422 before any `write` log row exists.
- int: 30 requests/min from one IP → 429 from the rate limiter.
- e2e: unauthenticated GET of a story URL → redirect to login.

### F12 — Admin dashboard (owner only)
**Scope:** `/admin` gated to `OWNER_USER_ID`. Shows: stories/day, cost/day, median and p95 cost per story, cache-read ratio, fact-pack hit rate, flagged-story rate, top topics, average latency, budget remaining. Kill switch and budget cap are read-only here (env-controlled) but displayed.
**AC**
- Non-owner gets 404 (not 403, to avoid revealing the page exists).
- All numbers are computed from `generation_logs` and `stories` with SQL views, not from application memory.
**VT**
- int: non-owner user → 404; owner → 200.
- unit/int: SQL view `v_daily_costs` sums to the same total as a direct `sum(cost_usd)` over `generation_logs` for a seeded day.
- int: seeded 10 stories with 8 fact-pack hits → dashboard shows 80% hit rate.

### F13 — Quality evaluation harness (golden set)
**Scope:** A repeatable `pnpm eval` that generates stories for a fixed set of 8 scenarios with `LIVE_API=1`, runs the quality gate, and scores each with the **Judge Agent** defined in `agents/JUDGE_AGENT.md` (six-criterion anchored rubric, blind, calibrated against the reference stories). Stores results in `eval/results/<date>.json` and prints a comparison against the previous run. Scenarios must include: band A pair on `history-of-lego`; band C solo on `history-of-video-games`; band A pair second story on `sharks` (continuity); band C second story on `history-of-soccer` (continuity); mixed ages (4, 7, 10) on `volcanoes`; 5-minute band A on `bees`; 15-minute band C on `space-race`; a sensitive-but-allowed topic, band B, `the-titanic`.
**AC**
- Judge calibration set (`JUDGE_AGENT.md` §5) passes before results count.
- Mean overall ≥ 4.0/5 and no scenario below 3.5 before launch; no story `disqualified`.
- Continuity scenarios reference a prior recurring element in chapter 1.
- Word counts within band range for all 8.
- `the-titanic` scenario passes with `scary_level ≤ 1` for band B.
- Any change to `prompts/master.*.md` or `prompts/judge.*.md` requires a re-run, and the PR must include the before/after summary.
**VT**
- The harness itself is the test. Wire it as a manual GitHub Action (`workflow_dispatch`) with the results file uploaded as an artifact.
- unit: rubric parser handles a malformed judge response without crashing the run.
- Plus all VTs in `JUDGE_AGENT.md` §7.

### F14 — Model bake-off (quality vs. cost)
**Scope:** `pnpm bakeoff`, implementing `JUDGE_AGENT.md` §6: Haiku vs Sonnet vs Opus vs the reference-story model as the writing model, 12 scenarios × 3 samples each, through the real pipeline, scored blind (absolute + pairwise with position swap, second judge on the top comparisons), with a generated markdown report covering quality, cost, latency and quality-per-dollar, plus the hybrid "Opus for the first story of a series, Sonnet after" option.
**AC**
- Writing model is a config value; the bake-off runs all contestants with no code changes.
- Report reconciles with `generation_logs` costs.
- Judge never sees contestant identity (asserted in tests).
- The owner makes the final model decision from the report; the chosen model and the report date are recorded in `README.md`.
**VT** — see `JUDGE_AGENT.md` §7.

### F15 — Guardrails (input and output)
**Scope:** Implement `GUARDRAILS.md` in full: L1 deterministic input checks, L2 Haiku input classifier with age-band awareness, L3 prompt constraints and data delimiting, L4 output gate (deterministic + safety review) integrated into F7, parent-facing message templates, `guardrail_events` logging with 24h raw-text retention, the red-team corpus in `test/guardrails/`, and a nightly live run of the corpus.
**AC**
- All pass criteria in `GUARDRAILS.md` §6 met; any regression blocks merge.
- Refusals cost no quota and no writing-model call.
- Parent never sees the triggering word or the layer.
- Prompt-injection in any parent field cannot alter the story rules (fixture tests).
**VT** — see `GUARDRAILS.md` §7. F7's VTs are extended to include the output hard-rule fixtures.

---

## 7. Suggested agent team and lanes

Dependencies: F1 → everything. F2 → F3 → F4/F10. F5 and F8 are independent of UI. F6 depends on F4, F5, F8. F7 depends on F6's schema. F9/F10 depend on F6's API contract (can start against the fixture API). F12 depends on F8. F13 depends on F6+F7.

| Lane | Agent | Features | Notes |
|---|---|---|---|
| 0 | Lead | F1, integration, code review | Scaffold first, then own the `lib/generate` interface contract so lanes 2–4 can build in parallel |
| 1 | Data & auth | F2, F3, F11 (server parts) | Migrations, RLS, tests |
| 2 | AI core | F4, F5, F6, F7 | Owns prompts under `prompts/`, fixtures under `test/fixtures/model/` |
| 3 | Cost & ops | F8, F12 | Pricing config, logging wrapper, dashboard |
| 4 | Frontend | F9, F10, F11 (UI parts) | Builds against fixture API from day 1 |
| 5 | Eval & judge | F13, F14 | Builds the judge and calibration first (can start against `reference-stories/` before F6 exists); bake-off once F6 streams end-to-end |
| 6 | Safety | F15 | Starts day 1 on L1 + the red-team corpus (no dependencies); integrates L2/L4 with lane 2 |

Working agreements for all agents:
- Model calls go through a single wrapper `lib/ai/callModel()` that handles logging, cost, retries, and fixtures. Nobody calls the SDK directly.
- Prompts live in `prompts/*.md` with a version header; changing a prompt requires re-running `pnpm eval`.
- Fixtures are recorded from real responses and committed; live tests are opt-in via `LIVE_API=1`.
- No feature merges without its VT list green in CI.

---

## 8. Launch checklist
- [ ] All F1–F12 and F15 VTs green in CI; F13 eval ≥ 4.0 mean with no disqualifications.
- [ ] Guardrail corpus pass criteria met on a live run within the last 7 days.
- [ ] Bake-off report reviewed by the owner; writing model chosen and recorded in README.
- [ ] `config/pricing.json` verified against docs.claude.com within the last 30 days.
- [ ] `DAILY_BUDGET_USD` set; kill switch tested in production.
- [ ] Admin dashboard shows real cost for 20 test stories; median cost per story recorded in README.
- [ ] Privacy page live; account deletion tested in production.
- [ ] Reader tested on iPhone Safari and Android Chrome.
- [ ] Ten fact packs pre-built for the suggested-topic chips so first users get instant cache hits.

---

## Appendix A — Reference stories
`reference-stories/` contains the four stories that set the quality bar. Use them for style excerpts in the master prompt (excerpts only), for gate calibration (F7), and for judge calibration (F13). Do **not** ship them as templates to copy; the goal is a system that produces stories of this quality for any family and topic.

## Appendix B — Open questions for the owner (do not block on these; use the default)
1. Tone list final? Default: funny, exciting, calm/sleepy, mysterious, silly, heart-warming.
2. Should parents be able to edit the Story Bible directly ("forget Grandpa Greenie")? Default: v1.1, not v1. Design the bible page but hide it behind a flag.
3. Suggested-topic chips: static list or driven by most-used fact packs? Default: both, 4 + 4.
