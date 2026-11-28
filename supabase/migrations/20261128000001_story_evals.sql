-- The owner's writer trial (issue #132): one row per saved story that the trial writer wrote,
-- so the book can be scored afterwards by the eval's judge and set beside the Sonnet eval.
--
-- Written in two steps. The story route inserts the row when the story is saved: who wrote
-- it, with which master prompt, the series bible as it was BEFORE the story (the judge scores
-- continuity against it, and `story_bibles` keeps only the latest), and what the parent saw
-- happen to the story after it began streaming. `pnpm eval:family` fills the judge columns
-- later. The judge never runs in the request path (JUDGE_AGENT.md s1).
--
-- No new field about anyone in the family (CLAUDE.md rule 7): `bible_before` is a copy of
-- what `story_bibles.content` already held, and the scores are numbers. The story's text is
-- not copied here. Family-scoped, so RLS is on; service role only, no policies, like
-- generation_progress. Removed with the story, and with the family.

create table story_evals (
  story_id              uuid primary key references stories (id) on delete cascade,
  family_id             uuid not null references families (id) on delete cascade,
  writer_model          text not null check (char_length(writer_model) between 1 and 100),
  -- `<prompt id>.v<version>`, e.g. `master.glm.v1`.
  master_prompt         text not null check (char_length(master_prompt) between 1 and 100),
  bible_before          jsonb,
  write_calls           int  not null check (write_calls >= 0),
  after_streaming       text not null check (after_streaming in ('unchanged', 'edited', 'replaced')),
  first_draft_untouched boolean not null,
  created_at            timestamptz not null default now(),

  -- Filled by `pnpm eval:family`. Null until the book is scored.
  judged_at             timestamptz,
  judge_model           text,
  judge_prompt          text,
  judge_prompt_sha      text,
  -- Set instead of the scores when the judge could not score the book.
  judge_error           text check (judge_error is null or char_length(judge_error) <= 500),
  scores                jsonb,
  overall_raw           numeric(4, 2),
  overall_final         numeric(4, 2),
  caps_applied          text[],
  disqualified          boolean,
  judge_cost_usd        numeric(10, 6)
);

create index story_evals_family_idx on story_evals (family_id, created_at desc);
create index story_evals_unjudged_idx on story_evals (created_at) where judged_at is null;

alter table story_evals enable row level security;
revoke all on story_evals from anon, authenticated;

comment on table story_evals is
  'Issue #132: stories written during the owner''s writer trial, and the eval judge''s score for each. Service role only.';
