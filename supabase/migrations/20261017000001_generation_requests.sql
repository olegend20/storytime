-- How each accepted story request ended (issue #59, DECISIONS #204).
--
-- A phone that loses the story stream asks "how did my request end?" by the id it sent with the
-- request (the `x-generation-id` header), instead of guessing from the library: a discarded
-- story has no `stories` row, so without this the page cannot tell "still writing" from "not
-- made". It is also the SQL source for the delivery rate (accepted requests that end in a saved
-- story). No child data and no story text: ids, a status, a reason code and two times.
-- Service role only: RLS on, no policies, like generation_logs; the route checks the family.
create table generation_requests (
  id uuid primary key,
  family_id uuid not null references families (id) on delete cascade,
  -- No foreign key: a discarded story never gets a row, and the id is kept for the record.
  story_id uuid,
  status text not null default 'writing'
    check (status in ('writing', 'ready', 'flagged', 'discarded', 'failed', 'refused')),
  -- A stable code (rule numbers, an error class), never the parent's words or the story's text.
  reason text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index generation_requests_family_started on generation_requests (family_id, started_at desc);
alter table generation_requests enable row level security;
revoke all on generation_requests from anon, authenticated;
