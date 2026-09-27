# Judge Agent — Specification, Prompt and Model Bake-off Protocol

> Lives at `agents/JUDGE_AGENT.md`. Implements the evaluation side of F13 and the whole of F14 in `IMPLEMENTATION_PLAN.md`. The judge is a *tool for the owner and the team*, not a runtime component: it never runs in the nightly generation path (the cheap Quality Gate in F7 does that). It runs in `pnpm eval` and `pnpm bakeoff`.

---

## 1. Purpose

Answer two questions with numbers instead of opinions:
1. **Is a given story as good as the reference stories?** (absolute score, 1–5 per criterion)
2. **Which of two stories for the same request is better, and why?** (pairwise preference)

Question 2 is the important one for choosing a writing model. Absolute scores from an LLM judge cluster around 4/5 and hide differences; pairwise comparison is far more sensitive and is the industry-standard way to compare models.

---

## 2. Design rules (why the judge is built this way)

- **Blind.** The judge never sees which model wrote a story, the cost, or the model name. Story text only.
- **Position-swapped.** Every pairwise comparison runs twice with A/B swapped. If the verdict flips, it is recorded as a tie. This removes the well-known "first answer wins" bias.
- **Length-controlled.** The judge is told the target word range and instructed that longer is not better; a story over the target range is penalized on *age fit*, not rewarded on *richness*.
- **Anchored rubric.** Each criterion has written examples of a 2, a 4 and a 5 so scores are comparable across runs and models.
- **Calibrated.** Before any run counts, the judge scores the four `reference-stories/`. They must average ≥ 4.5. If they don't, the judge prompt is fixed, never the references.
- **Judge model is fixed for a whole bake-off.** Use the strongest model available (Opus-class or above) as the judge, and never the same model as one of the contestants where avoidable. Self-preference bias is real: if a contestant must also be the judge, run the judge with a second judge model too and report both.
- **Repeat.** Each scenario × model is generated 3 times (temperature default). Report medians and spreads, not single samples.

---

## 3. Rubric (six criteria, 1–5 each)

| # | Criterion | What a 5 looks like | What a 2 looks like |
|---|---|---|---|
| 1 | **Children as heroes** | Every named child drives the plot: they solve the chapter's problem, get lines that only they could say, and their stated likes shape *what happens*, not just decoration. | Children are named but mostly watch a guide explain things; likes are mentioned once and forgotten. |
| 2 | **Story craft** | Cold open in the real world, clear device that launches the adventure, a mini-challenge per chapter, escalating stakes, a satisfying return home with a keepsake or callback, and a last line that lands. Shout-along moments for young bands. | A list of facts with a thin frame; chapters blur together; ending is abrupt. |
| 3 | **Factual grounding** | Facts are correct, come from the fact pack, are woven into action, and popular legends are flagged in-story. True Facts list is accurate and matches the story. | Invented dates or names, facts dumped in lectures, unhedged legends, True Facts list contains things not in the story. |
| 4 | **Age fit** | Vocabulary, sentence length, peril and humour match the band table exactly; mixed-age stories give the older child something in every chapter. Length within target range. | Too scary or too babyish for the band; a 4-year-old story with sarcasm, a 10-year-old story with baby talk; length far off. |
| 5 | **Series continuity** | Reuses the series' recurring device/guide naturally, references the previous ending in the opening, keeps catchphrases, adds at most one new recurring element and it's a good one. (Score 5 by default for a first story with no bible.) | Contradicts the bible, ignores recurring characters, or reinvents the device. |
| 6 | **Read-aloud delight** | A parent would be proud to read it: rhythm, jokes that land for both parent and child, sound words, a warm ending. No filler sentences. | Flat prose, repeated phrases, clichés, obvious AI tells ("Little did they know…"). |

**Automatic caps** (applied by the judge regardless of other scores):
- Any content that breaches `GUARDRAILS.md` output rules → overall score 1 and `disqualified: true`.
- Any invented fact contradicted by the fact pack → Factual grounding ≤ 2.
- Word count outside target ±15% → Age fit ≤ 3.

**Overall** = weighted mean: Heroes 0.2, Craft 0.2, Facts 0.2, Age fit 0.15, Continuity 0.1, Delight 0.15.

---

## 4. Judge prompt (store as `prompts/judge.v1.md`)

```
You are the Story Judge for StoryTime, a free app where parents read personalized, true-fact bedtime stories to their children. Your job is to score stories with the rigor of a children's book editor and the eye of a fact-checker. You are strict. A 5 is rare and must be earned. You never reward length for its own sake.

You will receive:
- REQUEST: the children (names, ages, likes, notes), age band, tones requested, target word range, topic.
- BIBLE: the series Story Bible (may be empty for a first story).
- FACT_PACK: the verified facts available to the writer.
- STORY (or STORY_A and STORY_B for pairwise mode).

MODE: SCORE
Score the story on six criteria using the rubric below. For each criterion give an integer 1–5 and one or two sentences of evidence quoting or pointing to specific passages. Then apply the automatic caps. Then compute the weighted overall. Finally write "editor_notes": the three most valuable changes that would make this story better, ordered by impact.

MODE: PAIRWISE
Both stories answer the same REQUEST. Compare them criterion by criterion, then give a verdict: "A", "B", or "TIE", with a confidence 0.5–1.0 and a one-paragraph justification that a parent could understand. Do not prefer the longer story. Do not prefer the story with more facts unless the facts are better used.

Rubric anchors:
[insert §3 table here verbatim]

Guardrail rules (any breach = disqualified):
[insert GUARDRAILS.md §4 output rules verbatim]

Respond with JSON only, matching the schema you are given. No prose outside the JSON.
```

**Output schema (SCORE mode)**
```json
{
  "scores": {"heroes": 4, "craft": 5, "facts": 4, "age_fit": 5, "continuity": 5, "delight": 4},
  "evidence": {"heroes": "…", "craft": "…", "facts": "…", "age_fit": "…", "continuity": "…", "delight": "…"},
  "caps_applied": ["none"],
  "disqualified": false,
  "overall": 4.45,
  "editor_notes": ["…", "…", "…"]
}
```
**Output schema (PAIRWISE mode)**
```json
{"per_criterion": {"heroes": "A", "craft": "TIE", "facts": "B", "age_fit": "A", "continuity": "TIE", "delight": "A"},
 "verdict": "A", "confidence": 0.8, "justification": "…"}
```

---

## 5. Calibration set

Run before every bake-off and whenever `prompts/judge.*.md` changes.

| Item | Expected |
|---|---|
| The four `reference-stories/` scored with their original requests | each overall ≥ 4.5 |
| A "sabotaged" copy of the LEGO story with Phoenix's name removed from all but one chapter | heroes ≤ 2 |
| A copy of the soccer story with three invented dates | facts ≤ 2 and the evidence names at least two of them |
| A copy of the shark story with a chapter where the great white chases the submarine and rams it | age_fit ≤ 2 for band A |
| A copy of the video-game story padded with 900 words of repeated description | age_fit ≤ 3, and delight not higher than the original |
| Pairwise: original LEGO story vs. sabotaged copy, both orders | "original" wins in both orders with confidence ≥ 0.7 |

If any expectation fails, stop and fix the judge prompt. Log the calibration result in `eval/results/calibration-<date>.json`.

---

## 6. Model bake-off protocol (F14)

**Contestants (writing model only; helper calls stay on Haiku for all runs):**
1. Haiku (current) — the cheap floor. Included so we know what we'd lose.
2. Sonnet (current) — the plan's default.
3. Opus (current) — the quality ceiling at the next price tier.
4. The model that wrote the reference stories (Claude Fable 5.1, `claude-fable-5-1`, if available on the API key) — included because the references are the bar.

Verify current model IDs and prices at docs.claude.com before the run; record them in `eval/results/bakeoff-<date>.json`.

**Scenarios:** the 8 from F13 plus 4 more chosen for difficulty: a topic with a well-known legend (`history-of-video-games`), a topic with sad history that must be handled gently for band B (`the-titanic`), a topic with almost no narrative (`how-magnets-work`, band A), and a topic where the parent's notes must matter (`history-of-soccer` for a child whose notes say "goalkeeper, hates losing").

**Procedure**
1. Build all fact packs once (shared across contestants).
2. For each scenario × contestant, generate 3 stories through the real pipeline (F6 + F7 gate), recording tokens, cost, latency, gate pass/rewrite/flag.
3. SCORE every story with the judge (blind).
4. PAIRWISE every contestant against Sonnet on each scenario, using the median-scored story of each, both orders.
5. Repeat step 3 with a second judge model for the 12 highest-stakes comparisons; report agreement rate.

**Report (`eval/results/bakeoff-<date>.md`, auto-generated)**
- Table: contestant × criterion median score, overall median, min, gate flag rate.
- Pairwise win/tie/loss vs Sonnet per contestant, with average confidence.
- Cost: median $/story, p95 $/story, $/story at 1,000 and 10,000 stories per month.
- Latency: p50/p95 seconds to first chapter and to completion.
- **Quality per dollar**: overall median ÷ median cost, and the pairwise win rate ÷ cost ratio.
- Three verbatim excerpts per contestant chosen by the judge as "best moment" and "worst moment".

**Decision rule (default; owner can override):** pick the cheapest contestant whose pairwise loss rate against the best contestant is ≤ 25% *and* whose gate flag rate is ≤ 5%. If Opus wins clearly, also report a **hybrid** option: Opus for the first story of a new series (where recurring characters are invented, which sets the tone for everything after) and Sonnet for subsequent stories, with its blended cost.

---

## 7. Verification tests for the judge and bake-off

- unit: judge output parser accepts both schemas; rejects a score of 6; handles a malformed response by retrying once then recording `judge_error`.
- unit: position-swap logic records TIE when the two orders disagree.
- int (LIVE_API): calibration set in §5 passes end-to-end.
- int: bake-off harness runs on a 1-scenario × 2-contestant × 1-sample config in fixture mode and produces the markdown report with all sections present.
- int: the report's cost figures reconcile with `generation_logs` for the run (sum matches within 0.1%).
- int: judge never receives model names — assert the judge prompt payload contains none of the contestant model IDs or the string "opus"/"sonnet"/"haiku" outside the rubric text.
