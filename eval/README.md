# eval/ — the quality evaluation harness (F13) and the model bake-off (F14)

Two commands, both of which spend real money, both of which refuse to start above an
approved ceiling.

```
pnpm eval      # F13: 8 fixed scenarios, quality gate, blind judge, results + comparison
pnpm bakeoff   # F14: JUDGE_AGENT.md §6 in full - 12 scenarios × 4 contestants × 3 samples
```

## Before you run anything

Both commands print a cost estimate computed from `config/pricing.json` **before** making a
single call, and refuse a live run whose estimate exceeds the approved ceiling (default $20,
from CLAUDE.md's stop-and-ask rule). See the numbers without spending anything:

```
pnpm eval --dry-run
pnpm bakeoff --dry-run
```

At the prices recorded on 2026-09-27:

| Run | Estimate |
|---|---|
| `pnpm eval` (8 scenarios, calibration included) | **$3.44** |
| `pnpm bakeoff` (12 × 4 × 3, both pairwise passes, second judge) | **$54.74** |
| judge calibration alone (`--calibration-only`) | **$1.27** |

A full bake-off is above the owner's threshold and needs their explicit approval, which is
then passed in as `--budget=<amount>`. Cheaper shapes: `--samples=2`,
`--no-pairwise-vs-best`, `--scenarios=<subset>`.

## The calibration gate

Neither command reports a number until the `JUDGE_AGENT.md` §5 calibration set passes: the
four reference stories each scoring ≥ 4.5 with their real requests, the four sabotaged
variants each collapsing on the right criterion, and the original beating the sabotaged copy
pairwise in both orders. If an expectation fails, **fix `prompts/judge.v1.md` — never the
reference stories.** A judge calibrated against our own output, grading our own output,
measures nothing.

Calibration results land in `eval/results/calibration-<date>.json` on every run.

## What is in here

| Path | What |
|---|---|
| `run-eval.ts` | `pnpm eval` |
| `run-bakeoff.ts` | `pnpm bakeoff` |
| `results/` | `eval-<date>.json`, `bakeoff-<date>.{json,md}`, `calibration-<date>.json`. Never overwritten: a second run on the same day gets a `-2` suffix. |
| `fixtures/stories/` | Optional recorded stories for fixture-mode runs, named `<scenario>.<model>.<sample>.json`. |

The judge itself lives in `lib/eval/`: the prompt loader and call machinery (`judge.ts`), the
blindness assertion (`blind.ts`), the data-block rendering (`render.ts`), the automatic caps
(`caps.ts`), the calibration set and its sabotages (`calibration.ts`, `sabotage.ts`), the
scenarios (`scenarios.ts`), the F6/F7 seam (`pipeline.ts`) and the report generator
(`report.ts`).

## Blocked on F6

`pnpm eval` and `pnpm bakeoff` generate stories through `lib/generate`'s
`createEvalPipeline()`, which lane 2 owns and which has not landed. Until it does, both
commands fail with an actionable message, and `EVAL_PIPELINE=fixture` substitutes the
synthetic pipeline in `lib/eval/synthetic.ts`.

**Synthetic stories are not model output.** Every artifact produced from them is stamped
`synthetic: true`, and the markdown report opens with `THIS IS NOT A BAKE-OFF RESULT`. They
exist so the harness could be built and tested end to end, not so a number could be
reported early.

## Tests

| Test | Covers |
|---|---|
| `test/unit/judge.test.ts` | output parser, blindness, prompt injection, the caps context, malformed-response handling |
| `test/unit/eval-calibration.test.ts` | the four sabotages, and the calibration checker's verdict on a well-behaved and on a flattering judge |
| `test/int/eval-harness.test.ts` | the eight scenarios end to end, the F13 acceptance checks, the results file and the previous-run comparison |
| `test/int/bakeoff.test.ts` | the §6 protocol on a 1 × 2 × 1 config, every report section, cost reconciliation against `generation_logs` |
| `test/int/judge-live.test.ts` | **skipped unless `LIVE_API=1`** — the §5 calibration set and the injection test against the real judge |

Judge calls in the tests go through the real `callModel()` in replay mode; the fixtures are
fabricated into a temp directory by `test/helpers/judge-fixtures.ts`, so nothing there can be
mistaken for a recorded response.
