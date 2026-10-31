-- The story so far, for a page that lost its stream (issue #82, DECISIONS #214).
--
-- A phone that locks or switches apps loses the story stream, while the server keeps writing
-- (#59). Each server request runs on its own, so a returning page cannot rejoin the writing
-- request's stream: it reads this row instead and carries on from where it stopped. One row
-- per request, updated at most every 1.5 s while prose streams: the stream's events folded to
-- a compact list (facts, meta, each chapter whole, the terminal event).
--
-- No new field about a child: `events` is the story being written, the same text and first
-- names the `stories` row holds once saved. Temporary: rows older than an hour are deleted
-- whenever a request starts (lib/generate/progress.ts), long after the route's maxDuration.
-- Service role only: RLS on, no policies, like generation_requests; the route checks the family.
create table generation_progress (
  generation_id uuid primary key references generation_requests (id) on delete cascade,
  family_id uuid not null references families (id) on delete cascade,
  version integer not null,
  events jsonb not null,
  updated_at timestamptz not null default now()
);
create index generation_progress_updated on generation_progress (updated_at);
alter table generation_progress enable row level security;
revoke all on generation_progress from anon, authenticated;
