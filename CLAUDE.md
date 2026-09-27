# StoryTime — working agreements

Read `storytime-plan/IMPLEMENTATION_PLAN.md` before changing anything. On conflicts:
`GUARDRAILS.md` wins on safety, `IMPLEMENTATION_PLAN.md` wins on everything else.

## Non-negotiable

1. **Every model call goes through `lib/ai/callModel()`** (or `streamModel()`). No direct
   `@anthropic-ai/sdk` calls anywhere else. The wrapper owns logging, cost, retries,
   prompt caching and fixtures — bypassing it makes cost per story unknowable.
2. **Model IDs and prices are config** (`config/models.json`, `config/pricing.json`),
   never literals in source. Before editing either, re-fetch
   <https://platform.claude.com/docs/en/models/overview> and
   <https://platform.claude.com/docs/en/about-claude/pricing> and cite the fetch date.
   Never edit a price from memory.
3. **Tests replay fixtures by default.** Live calls need `LIVE_API=1`. Record with
   `LIVE_API=1 RECORD_FIXTURES=1 pnpm test`. Never commit an API key.
4. **A feature is done only when every VT in its section passes in CI.**
5. **Prompts live in `prompts/*.md` with a version header.** Changing
   `prompts/master.*.md`, `prompts/judge.*.md` or the guardrail classifier prompt requires
   re-running the affected eval and putting the before/after in the PR description.
6. **Guardrail regressions block merge** (`GUARDRAILS.md` §6 pass criteria).
7. **Children's data is minimal**: first name, age, likes, notes, reading level. Never add
   a birthdate, surname, photo or location field. RLS on every family-scoped table.
8. **Never put a previous story's text into a generation prompt.** Series memory is the
   ≤800-token Story Bible plus the shared Fact Pack. If you find yourself reaching for
   story history, stop — that is the exact cost problem this design exists to prevent.

## Stop and ask the owner

Do not guess on: storing more about a child; loosening any guardrail rule or pass
criterion; changing the daily limit, budget cap or default length; **picking the writing
model**; spending more than ~$20 of API budget in one eval or bake-off run (estimate from
`config/pricing.json` first and report the number); or a live API failure that suggests the
configured model IDs or prices are wrong.

## `lib/schemas/` is a contract

It is shared by every lane. Do not change a schema without the lead's sign-off — other
lanes are building against it. If you need a shape that isn't there, ask.

## Commands

```
pnpm dev              # local dev server
pnpm test             # unit + int, fixture mode (excludes test/blocked)
pnpm test:blocked     # tests waiting on an external dependency
pnpm test:e2e         # Playwright
pnpm test:guardrails  # red-team corpus
pnpm test:schema      # DB introspection (needs `supabase start`)
pnpm eval             # F13 golden set — LIVE, costs money
pnpm bakeoff          # F14 model bake-off — LIVE, costs real money
```

## Conventions

- Reason codes in the quality gate and guardrails are **stable enums**
  (`lib/schemas/quality.ts`, `guardrail.ts`). Tests assert on codes, not prose, so
  messages can be reworded without breaking the suite.
- Parent-facing refusal copy lives in `config/guardrails/messages.json`. Never echo the
  triggering text back, and never reveal which layer fired.
- Cost-relevant numbers come from SQL views (`v_*`), never from application memory (F12).
