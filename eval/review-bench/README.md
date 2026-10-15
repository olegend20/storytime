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
