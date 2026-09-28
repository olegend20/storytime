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
| 1 | **Children at the center** | The named children are present and active in nearly every chapter: they do things (climb, build, kick, grab, test), ask the questions a curious kid would ask, make choices, react in ways that are distinctly theirs, and get lines only they could say. Their stated likes and notes shape how at least one scene plays out. The story would not work with the children removed. Solving a problem is one way to be active, not the only way: discovering, trying, asking, choosing, and joining in all count. | Children are named at the start, then a guide lectures while they nod along; scenes would read the same with the kids deleted; likes are mentioned once and forgotten. |
| 2 | **Story craft** | Cold open in the child's real world, a clear device that launches the adventure, and a beat in every chapter that gives the kids something to do or find out: a discovery, a surprise, a choice, a hands-on moment, or a challenge. Momentum builds, there's a satisfying return home with a keepsake or callback, and a last line that lands. Shout-along moments for young bands. A learning journey with no villain and no jeopardy can still score 5 if each chapter has a beat and the whole has a shape. | A list of facts with a thin frame; chapters blur together and are interchangeable; ending is abrupt. |
| 3 | **Factual grounding** | Facts are correct, come from the fact pack, are woven into action, and popular legends are flagged in-story. True Facts list is accurate and matches the story. | Invented dates or names, facts dumped in lectures, unhedged legends, True Facts list contains things not in the story. |
| 4 | **Age fit** | Vocabulary, sentence length, peril and humour match the band table exactly; mixed-age stories give the older child something in every chapter. Length within target range. | Too scary or too babyish for the band; a 4-year-old story with sarcasm, a 10-year-old story with baby talk; length far off. |
| 5 | **Series continuity** | Reuses the series' recurring device/guide naturally, references the previous ending in the opening, keeps catchphrases, adds at most one new recurring element and it's a good one. (Score 5 by default for a first story with no bible.) | Contradicts the bible, ignores recurring characters, or reinvents the device. |
| 6 | **Read-aloud delight** | A parent would be proud to read it: rhythm, jokes that land for both parent and child, sound words, a warm ending. No filler sentences. | Flat prose, repeated phrases, clichés, obvious AI tells ("Little did they know…"). |

**Automatic caps** (applied by the judge regardless of other scores):

- Any content that breaches `GUARDRAILS.md` output rules → overall score 1 and `disqualified: true`.
- Any invented fact contradicted by the fact pack → Factual grounding ≤ 2.
- Word count outside target ±15% → Age fit ≤ 3.

**How to score criterion 1 (Children at the center).** Count the chapters. For each chapter, and for **each named child separately**, mark whether that child does one of the following: performs a physical action that matters to the scene; asks a question that a fact or character then answers; makes a choice or suggests an idea; reacts in a way that is specific to that child (not "the kids gasped"); or is addressed by a historical figure or guide and answers in their own voice. **Count per named child, and score the worst-covered child** - the anchor says the childREN are active in nearly every chapter, so a story where one of two siblings is decoration must not score on the other's back. Then, for that worst-covered child: every chapter → 5; all but one → 4; roughly two-thirds → 3; about half → 2; fewer → 1. If any named child goes silent for three consecutive chapters, cap at 3. If the children's stated likes or notes never change a scene, subtract 1.

**Worked examples from the reference stories** (these must all land at 4–5, which is the point of the calibration set):

- **Shark Submarine** is a guide-led discovery story with no villain. It scores **5** because in every chapter the boys ask a question, press noses to the glass, squeeze their noses to feel cartilage, pick up a tooth with the grabber arm, name the "nightlight shark," or hold hands when the great white appears. Nothing is solved, but nothing would work without them.
- **The Beautiful Game** mixes both modes: Lennon organizes other kids in the arcade and takes the first penalty in history (problem-solving), but he also just kicks a feathered ball, argues with men in top hats, and scratches a dog's ears (participation). Both kinds count equally.
- **Brick That Clicked** has Cruz suggest the tubes idea (an idea), Phoenix pull the wooden duck around (an action), and both shout "LEGO!" (a reaction). A younger-band story earns its 5 mostly through actions and shout-lines, not decisions.

**Overall** = weighted mean: Center 0.2, Craft 0.2, Facts 0.2, Age fit 0.15, Continuity 0.1, Delight 0.15.

## 4. Judge prompt (store as `prompts/judge.v2.md` (v1 penalized learning journeys for lacking problems to solve; v2 scores presence and agency))

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
  "scores": {"center": 4, "craft": 5, "facts": 4, "age_fit": 5, "continuity": 5, "delight": 4},
  "evidence": {"center": "…", "craft": "…", "facts": "…", "age_fit": "…", "continuity": "…", "delight": "…"},
  "caps_applied": ["none"],
  "disqualified": false,
  "overall": 4.45,
  "editor_notes": ["…", "…", "…"]
}
```
**Output schema (PAIRWISE mode)**
```json
{"per_criterion": {"center": "A", "craft": "TIE", "facts": "B", "age_fit": "A", "continuity": "TIE", "delight": "A"},
 "verdict": "A", "confidence": 0.8, "justification": "…"}
```

---

## 5. Calibration set

Run before every bake-off and whenever `prompts/judge.*.md` changes.

| Item | Expected |
|---|---|
| The four `reference-stories/` scored with their original requests | each overall ≥ 4.5 |
| A "sabotaged" copy of the LEGO story with Phoenix's name removed from all but one chapter | center ≤ 2 |
| A copy of the soccer story with three invented dates | facts ≤ 2 and the evidence names at least two of them |
| A copy of the shark story with a chapter where the great white chases the submarine and rams it | age_fit ≤ 2 for band A |
| A copy of the video-game story padded with 900 words of repeated description | **delight drops by ≥ 2 versus the original.** Age fit is NOT asserted: §3 already gives age fit a mechanical claim on length (outside ±15% → ≤ 3), and this padding sits *inside* the tolerance, so penalising it there would duplicate that rule and blur the criterion. Delight's own anchor ends "No filler sentences", and 900 words of repeated description is filler. Owner's decision, 2026-09-28. |
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
