# Quality-reviewer bench (issue #58)

`pnpm review-bench` replays only the F7 quality reviewer on a frozen set of first drafts.

- `set-2026-10-15.json`: 32 first drafts, one per golden-set scenario, written by
  `claude-sonnet-5` through `runGeneration` and stopped at the gate (`firstDraftOnly`). $5.68.
- `labels-2026-10-15.json`: hand labels: should the reviewer pass this draft? 11 of 32 pass.
- `candidates/`: the prompts tried. `a-short-facts` shipped as `prompts/quality-review.v4.md`.

| run file | prompt | half | format failures | wrong fails | catches | flips |
|---|---|---|---|---|---|---|
| `run-quality-review-v3-2026-10-15.json` | v3 (shipped before) | train | 2/48 | 10/15 | 15/33 | 1/16 |
| `run-quality-review-v4-2026-10-15.json` | A, short reasons + omitted facts | train | 1/48 | 6/15 | 15/33 | 3/16 |
| `run-quality-review-v4-2026-10-15-2.json` | B, reasons first | train | 0/48 | 10/15 | 20/33 | 8/16 |
| `run-quality-review-v4-2026-10-15-3.json` | C, B + worked examples | train | 1/48 | 9/15 | 21/33 | 10/16 |
| `run-quality-review-v4-2026-10-15-5.json` | D, A + `checks` first | train | 0/48 | 2/15 | 8/33 | 9/16 |
| `run-quality-review-v4-2026-10-15-4.json` | E, A + no concessions | train | 1/48 | 12/15 | 12/33 | 2/16 |
| `run-quality-review-v3-2026-10-15-2.json` | v3 | test | 5/48 | 12/18 | 21/30 | 3/16 |
| `run-quality-review-v4-2026-10-15-6.json` | A | test | 5/48 | 12/18 | 27/30 | 2/16 |

Wrong fails count reviews of drafts labelled pass; catches count reviews of drafts labelled
fail. The train-half runs were scored against the labels after they ran. Tune on
`--split=train`; score a winner on `--split=test` once.

## Claude Haiku 5.5 (2026-10-15)

Same set and labels, reviewer `claude-haiku-5-5` (adaptive thinking on unless `--thinking=off`).

| half | prompt | effort | reviews per draft | format failures | wrong fails | catches | flips | accuracy | run file |
|---|---|---|---|---|---|---|---|---|---|
| train | v3 | medium | 3 | 0/48 | 2/15 | 27/33 | 6/16 | 83% | `run-quality-review-v3-v3-claude-haiku-5-5-train-2026-10-15.json` |
| train | v4 (shipped) | high | 3 | 0/48 | 6/15 | 24/33 | 2/16 | 69% | `run-quality-review-v4-v4-claude-haiku-5-5-high-train-2026-10-15.json` |
| train | v4 (shipped) | low | 3 | 0/48 | 1/15 | 17/33 | 5/16 | 65% | `run-quality-review-v4-v4-claude-haiku-5-5-low-train-2026-10-15.json` |
| train | v4 (shipped) | medium | 3 | 0/48 | 5/15 | 18/33 | 7/16 | 58% | `run-quality-review-v4-v4-claude-haiku-5-5-train-2026-10-15.json` |
| train | v4 (shipped) | medium thinking off | 3 | 0/48 | 12/15 | 22/33 | 1/16 | 52% | `run-quality-review-v4-v4-claude-haiku-5-5-nothink-train-2026-10-15.json` |
| train | b-reasons-first | medium | 5 | 0/80 | 4/25 | 36/55 | 6/16 | 71% | `run-quality-review-v4-B-claude-haiku-5-5-train-2026-10-15.json` |
| train | c-explained-patterns | medium | 5 | 0/80 | 4/25 | 35/55 | 6/16 | 70% | `run-quality-review-v4-C-claude-haiku-5-5-train-2026-10-15.json` |
| train | d-checks-first | medium | 5 | 0/80 | 4/25 | 30/55 | 7/16 | 64% | `run-quality-review-v4-D-claude-haiku-5-5-train-2026-10-15.json` |
| train | e-no-concessions | medium | 5 | 0/80 | 2/25 | 33/55 | 7/16 | 70% | `run-quality-review-v4-E-claude-haiku-5-5-train-2026-10-15.json` |
| train | f-procedures | high | 5 | 0/80 | 15/25 | 55/55 | 2/16 | 81% | `run-quality-review-v4-F-claude-haiku-5-5-high-train-2026-10-15.json` |
| train | f-procedures | medium | 5 | 0/80 | 15/25 | 55/55 | 2/16 | 81% | `run-quality-review-v4-F-claude-haiku-5-5-train-2026-10-15.json` |
| train | g-procedures-substantial | medium | 5 | 0/80 | 12/25 | 53/55 | 4/16 | 82% | `run-quality-review-v4-G-claude-haiku-5-5-train-2026-10-15.json` |
| train | v3 | high | 5 | 0/80 | 9/25 | 45/55 | 9/16 | 76% | `run-quality-review-v3-v3-claude-haiku-5-5-high-train-2026-10-15.json` |
| train | v3 | medium | 5 | 0/80 | 10/25 | 36/55 | 10/16 | 64% | `run-quality-review-v3-v3-claude-haiku-5-5-train-2026-10-15-2.json` |
| train | v4 (shipped) | high | 5 | 0/80 | 9/25 | 36/55 | 6/16 | 65% | `run-quality-review-v4-v4-claude-haiku-5-5-high-train-2026-10-15-2.json` |
| train | v4 (shipped) | medium | 5 | 0/80 | 5/25 | 33/55 | 4/16 | 66% | `run-quality-review-v4-v4-claude-haiku-5-5-train-2026-10-15-2.json` |
| test | g-procedures-substantial | medium | 5 | 0/80 | 22/30 | 47/50 | 5/16 | 69% | `run-quality-review-v4-G-claude-haiku-5-5-test-2026-10-15.json` |
| test | v4 (shipped) | medium | 5 | 0/80 | 7/30 | 31/50 | 8/16 | 68% | `run-quality-review-v4-v4-claude-haiku-5-5-test-2026-10-15.json` |

Accuracy is reviews that agree with the hand label, over all reviews. With 16 drafts a half,
differences under about 10 points are noise (v3 at medium scored 83% with 3 reviews per draft
and 64% with 5). Candidates F (participation and unsupported-claim procedures) and G (F with
the fact check narrowed to substantial facts) are in `candidates/`.

## Shipped, and what the bench is for next (2026-10-15)

The owner moved the quality review to Haiku 5.5 with thinking and prompt v4 (DECISIONS #201).
`--model` now defaults to the `quality_reviewer` role.

The bench also scores the **writer** (DECISIONS #202). Every run prints how many first drafts
the reviewer passes, which judgement failed the rest, and the gate's deterministic checks. No
labels are needed. Master v5's baseline, on `set-2026-10-15.json`, re-read from the runs above:

| | reviews passing | children only watch | facts | other |
|---|---|---|---|---|
| reviewer v4 (shipped) | 84 / 160 (52%) | 37 | 30 | 22 |
| reviewer G (strict) | 26 / 160 (16%) | 86 | 88 | 22 |
| deterministic checks | 24 / 32 drafts | | | word count 3, banned word 2, 4 others |

To score a candidate writer prompt, put it in `prompts/master.v<N>.md` (the newest version
is the one used; `PROMPT_PIN_MASTER=<N>` pins another), build a train set (~$2.70), then
score it with the shipped reviewer (~$0.15 at list):

```
pnpm review-bench --build --scenarios=split:train --label=master-v6
pnpm review-bench --set=eval/review-bench/set-master-v6-<date>.json --samples=3
```

The strict reviewer G is switched on only once first drafts pass it as often as they pass v4
today.

## Writer hill-climb (2026-10-16, DECISIONS #203)

Each candidate wrote the 16 train-half first drafts once, scored 3 times by each reviewer.
"Clean" is a review that passes on a draft that also passes the deterministic checks: a first
draft the gate would accept without a rewrite (the L4 safety review is not part of the bench).

| writer | half | drafts | reviewer v4 passes | clean (v4) | G passes | clean (G) | deterministic | sets / runs |
|---|---|---|---|---|---|---|---|---|
| v5 (shipped) | train | 16 | 67/128 (52%) | 59/128 (46%) | 15/80 (19%) | 13/80 (16%) | 14/16 | `set-2026-10-15.json` |
| **v6** | train | 15 | 31/45 (69%) | **28/45 (62%)** | 16/45 (36%) | 13/45 (29%) | 13/15 | `set-master-v6-2026-10-17.json` |
| v7 | train | 16 | 31/48 (65%) | 21/48 (44%) | 24/48 (50%) | 15/48 (31%) | 11/16 | `set-master-v7-2026-10-17.json` |
| v8 | train | 15 | 30/45 (67%) | 22/45 (49%) | 16/45 (36%) | 14/45 (31%) | 11/15 | `set-master-v8-2026-10-17.json` |
| v5 (shipped) | test | 16 | 42/80 (53%) | 28/80 (35%) | 11/80 (14%) | 9/80 (11%) | 10/16 | `set-2026-10-15.json` |
| **v6** | test | 16 | 33/48 (69%) | **30/48 (63%)** | 18/48 (38%) | 18/48 (38%) | 13/16 | `set-master-v6-test-2026-10-17.json` |

v6 shipped as `prompts/master.v6.md`. v7 and v8 are kept in `candidates/master-v7-numbers-words`
and `candidates/master-v8-blocked-words`. One draft each was lost on v6 train (the gateway
dropped the write stream) and v8 train (the input guard refused `volcanoes-mixed-ages` as
too mature, a false positive). Each writer was sampled once, and 5 of 15 drafts flip between
pass and fail across 3 reviews, so gaps of a few points between v6, v7 and v8 are noise; the
v5 to v6 gain held on the test half, which was not used to choose.
