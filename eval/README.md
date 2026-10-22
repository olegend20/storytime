# eval/ — the quality evaluation harness (F13) and the model bake-off (F14)

Two commands, both of which spend real money, both of which refuse to start above an
approved ceiling.

```
pnpm eval      # F13: 32 fixed scenarios (train/test halves), quality gate, blind judge, results + comparison
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
| `pnpm eval` (32 scenarios, calibration included; issue #48) | **$14.73** ($13.64 reusing a calibration; measured $14.15 on 2026-10-14) |
| `pnpm bakeoff` (12 × 4 × 3, both pairwise passes, second judge) | **$128.51** |
| judge calibration alone (`--calibration-only`) | **$1.09** (measured $1.58) |

Since 2026-10-14 (DECISIONS #196) the estimate counts rewrites at the measured rate (70% of
stories) and the judge's measured output; before, it ran 1.6-2.2x low. The bake-off figure
roughly doubled for the same reason - it was never as cheap as it said.

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

## The golden set and its train/test halves (issue #48)

32 scenarios: F13's eight, then 24 appended to fill every band x length cell (at least 3
each, band D included) and to aim at failures the judge has caught - sibling insults, touching
wild animals, copyable unsafe acts, care topics at different ages, continuity. Sized so a
change of about +/-0.2 in quality or 20% in latency shows above run-to-run noise (per-story
swing SD ~0.38 between the 2026-10-06 and 2026-10-14 runs).

Each scenario has a fixed half in `EVAL_SPLIT` (`lib/eval/scenarios.ts`), 16 and 16,
stratified by cell. When hill-climbing, keep a change only if **both** halves improve; one
that helps only the half it was tuned on is overfitting. Run one half with
`pnpm eval --scenarios=split:train` (or `split:test`).

## Latency (issue #46)

Every `pnpm eval` reports, per story, the **time to first chapter** - how long a parent waits
before the story starts appearing, and the number to hill-climb - the total time to a saved
story, and where the time went by step (calls, ms and output tokens per purpose; the writer's
thinking is in its output tokens). The summary has median and p95, and the comparison against
the last run marks any story whose first chapter moved by 20% or more. Latency is reported,
never a pass criterion: one sample per scenario through a remote API is too noisy to gate on.

A live run also prints a `drops (issue #78):` line: per call purpose, the calls that failed by
who ended them (`peer_reset`, `peer_end`, `upstream_error`, ...), our own aborts counted apart,
the longest silence on any one call, and pings per minute. `--thinking-display=summarized`
streams the writer's thinking summary instead of Sonnet 5's silent default, to measure it.

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
| `test/int/eval-harness.test.ts` | every eval scenario end to end, the F13 acceptance checks, the results file and the previous-run comparison |
| `test/int/bakeoff.test.ts` | the §6 protocol on a 1 × 2 × 1 config, every report section, cost reconciliation against `generation_logs` |
| `test/int/judge-live.test.ts` | **skipped unless `LIVE_API=1`** — the §5 calibration set and the injection test against the real judge |

Judge calls in the tests go through the real `callModel()` in replay mode; the fixtures are
fabricated into a temp directory by `test/helpers/judge-fixtures.ts`, so nothing there can be
mistaken for a recorded response.
