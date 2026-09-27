# reference-stories/ — MISSING, needed from the owner

This directory should hold the **four reference stories** that define StoryTime's quality
bar. They were **not** in the handover archive: `files (1).zip` contained only
`IMPLEMENTATION_PLAN.md`, `GUARDRAILS.md` and `JUDGE_AGENT.md`.

## What is blocked without them

| Where | What it needs |
|---|---|
| `IMPLEMENTATION_PLAN.md` §4.1.8 | 3 style-anchor excerpts (≤120 words each) inside the master prompt |
| `JUDGE_AGENT.md` §5 | All six calibration rows — the references must average ≥ 4.5, plus the four sabotaged variants derived from them |
| F13 AC | "Judge calibration set passes before results count" — the eval gate itself |
| F7 VT | "The four reference stories pass the deterministic gate with their original inputs" |
| F5 VT (live) | Fact packs must contain anchor facts drawn from their True Facts lists |

## What is *not* blocked

F1–F12 and F15 in full, and the structure of F4–F7. Lane 5 builds the judge harness,
output parser, position-swap logic, blind-payload assertions and report generator against
synthetic inputs; only *calibration* waits.

## Please do not substitute generated stories

`test/unit/reference-stories.test.ts` fails until four `.md` files land here. That failure
is deliberate. Filling this directory with model-written stories would make the judge
calibrate against our own output and then grade our own output — a green dashboard with no
information in it. If the originals are truly unavailable, that is a decision for the
owner to make explicitly, and it needs recording in `DECISIONS.md` along with what the
quality bar becomes instead.

## Expected shape

Four markdown files, roughly:

- `01-history-of-lego.md` — band A pair (Cruz 7, Phoenix 4); anchors "leg godt", 1958 patent
- `02-sharks.md` — band A pair, continuity story (Grandpa Greenie, the magic red brick)
- `03-history-of-soccer.md` — band C; anchors William McCrum, Pickles the dog
- `04-history-of-video-games.md` — band C; contains a flagged popular legend

Each should carry its original request (children, ages, likes, tones, length) in
frontmatter so F7's and F13's "original inputs" assertions have something to read.
