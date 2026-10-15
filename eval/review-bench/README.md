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
