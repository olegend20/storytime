# StoryTime

A free website where a parent registers their children and generates a personalized,
true-fact, read-aloud bedtime story every night in which their kids are the heroes.

Text only, no images. Free to parents; the owner pays all inference costs — so **cost per
story and content safety are first-class requirements, equal to story quality.**

## Setup

Requires Node 20+, pnpm, Docker (for local Supabase), and the Supabase CLI.

```bash
pnpm install
cp .env.example .env.local     # fill in ANTHROPIC_API_KEY and the Supabase keys
supabase start                 # prints the local anon + service-role keys
pnpm migrate
pnpm seed                      # one family, two children
pnpm dev
```

Magic-link emails land in the local mailbox at <http://127.0.0.1:54324>.

## Try it yourself (real stories, real cost)

`pnpm dev` alone **cannot make a story**: without `LIVE_API=1` every model call looks for a
recorded test fixture and fails, and the form says it couldn't make a story. To generate for
real:

```bash
supabase start
LIVE_API=1 DAILY_BUDGET_USD=2 pnpm dev   # the cap stops new stories once today's spend hits $2
```

1. Open <http://localhost:3000>, **Sign in**, and open the link from the local mailbox
   (<http://127.0.0.1:54324>).
2. **Add a child** on the Children page.
3. **New story** → pick the child, a tone and a length, and **pick one of the suggested chips
   marked "starts straight away"**.

**What it costs.** A story is about **$0.17** (the writer thinks before it writes; that is
most of it), or roughly double when the quality gate asks for a rewrite. The first time anyone
asks about a new topic, a fact pack is written from the model's knowledge first: ~30 seconds
and a few cents. Only when the model says it does not know the topic does it research the web
(~1–2 minutes, ~$0.45). Real spend is on the Anthropic console; `/admin` shows what the app
recorded.

**Rehearsed without spending:** `pnpm test:e2e:real` runs sign-in → add a child → the form →
a refused topic → library, reader and delete against the real app with model calls disabled.

## Tests, eval and bake-off

Model-calling tests replay **recorded fixtures** by default; nothing reaches the live API
unless you ask it to.

```bash
pnpm test             # unit + integration, fixture mode
pnpm test:e2e         # Playwright, desktop + 375px mobile, against the mock backend
pnpm test:e2e:real    # Playwright against the REAL app and Supabase, model calls disabled
pnpm test:guardrails  # red-team corpus (GUARDRAILS.md §6)
pnpm test:schema      # DB introspection — needs `supabase start`
pnpm test:blocked     # tests waiting on an external dependency (see below)

# Re-record fixtures from real responses after a prompt change:
LIVE_API=1 RECORD_FIXTURES=1 pnpm test
```

```bash
pnpm eval      # F13 golden set: 8 scenarios, judged. LIVE — costs money.
pnpm bakeoff   # F14 model bake-off. LIVE — costs real money; estimate first.
```

Both write to `eval/results/`. `pnpm eval` refuses to report a score until the judge
calibration set passes (`JUDGE_AGENT.md` §5).

## Chosen writing model

**Not yet chosen.** The writing model is decided by the owner from the F14 bake-off report,
not by the build. Until then the placeholder default is `claude-sonnet-5`, set in
`config/models.json` and overridable with `WRITING_MODEL`.

| | |
|---|---|
| Chosen writing model | _pending bake-off_ |
| Bake-off report | _pending_ |
| Measured median cost per story | _pending — needs 20 real stories (launch checklist)_ |

Rough expectations from `config/pricing.json` at ~5k output tokens per 10-minute story:
Haiku ~$0.045, Sonnet 5 ~$0.071, Opus 5.5 ~$0.125, Fable 5.1 ~$0.284. Output tokens are
~70% of the cost, so the writing model is the dominant cost lever.

## Cost controls

Two env vars, both effective **without a deploy**:

| Var | Effect |
|---|---|
| `GENERATION_ENABLED` | Kill switch. `false` → generation returns a friendly "paused" message. Reading saved stories keeps working. |
| `DAILY_BUDGET_USD` | Global daily cap. Once the day's `generation_logs` total exceeds it, generation returns 503 "paused for today". |

To flip either: change the value in the Vercel project's environment variables and
redeploy is *not* required — they are read per request. Per-family limits (3 stories/day,
in the family's own timezone) are independent and always on.

`/admin` (owner only, `OWNER_USER_ID`) shows stories/day, cost/day, median and p95 cost per
story, cache-read ratio, fact-pack hit rate and budget remaining — all computed from SQL
views over `generation_logs`, never from application memory.

## How cost is kept down

1. **History is never reloaded.** Series memory is a ≤800-token Story Bible, not a
   transcript. This is the single most important constraint in the codebase.
2. **Research once, reuse forever.** Topic Fact Packs are built once per topic (the only
   step allowed to use web search) and shared by every family.
3. **The master prompt is cached**, so it bills at the cache-read rate (10× cheaper on
   Sonnet 5, 20× on Opus 5.5).
4. **One expensive call per story**, plus at most one rewrite. Everything else runs on
   Haiku.
5. **Bounded worst case**: per-family daily limit, global budget cap, kill switch.
6. **Everything measured**: every call logs tokens, cache hits, latency and computed cost.

## Documentation

| File | What |
|---|---|
| `storytime-plan/IMPLEMENTATION_PLAN.md` | Architecture, data model, prompts, cost model, F1–F15 with AC and VTs |
| `storytime-plan/GUARDRAILS.md` | Four-layer content safety (F15). Non-negotiable |
| `storytime-plan/agents/JUDGE_AGENT.md` | Quality judge, calibration, bake-off protocol |
| `CLAUDE.md` | Working agreements for anyone (human or agent) touching this repo |
| `DECISIONS.md` | Every judgment call, with its reason and date |
| `PROGRESS.md` | Feature status, VT counts, session log, open questions |

## The quality bar

`storytime-plan/reference-stories/` holds the four stories that define what "incredible"
means for this product, plus a `manifest.json` recording each story's original request and
the series state before it — so the judge can score them with their real inputs
(`JUDGE_AGENT.md` §5). They were written by `claude-fable-5-1`, which is therefore
contestant 4 in the bake-off.

`lib/reference.ts` parses them into the same `StoryOutput` shape as a generated story, so
F7's gate and the judge both read one definition of "the story". What they establish:

| | Band A (ages 3–5) | Band C (ages 9–12) |
|---|---|---|
| Journey stops | 7–10 | 9 |
| Narrative words | 1,549 / 1,859 | 2,474 / 2,643 |
| True facts | 8–14 | 10–13 |
| Closing line | direct bedtime address after "The End" — *"Goodnight, Cruz. Goodnight, Phoenix. Play well."* | forward-looking final beat — *"Tomorrow, he had a game to make."* |

Both band A references sit above the nominal 1,700-word ceiling for their band and pass
only on the ±15% tolerance. Worth knowing before anyone tightens that tolerance.
