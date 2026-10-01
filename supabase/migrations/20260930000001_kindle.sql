-- Send a story to a Kindle (issue #11, DECISIONS #150).
--
-- One optional column on the PARENT's family row: the Kindle's Send-to-Kindle address. It is
-- parent data, not child data (rule 7 untouched), and the family's own policies cover it.
alter table families add column kindle_email text
  check (kindle_email is null or kindle_email ~* '^[a-z0-9][a-z0-9._-]{0,62}@(free\.)?kindle\.com$');

-- Every send, for the daily limit and the admin view. Service role only: RLS on, no policies,
-- like generation_logs.
create table story_sends (
  id uuid primary key default gen_random_uuid(),
  family_id uuid references families (id) on delete cascade,
  story_id uuid references stories (id) on delete set null,
  to_address text not null,
  created_at timestamptz not null default now()
);
create index story_sends_family_day on story_sends (family_id, created_at desc);
alter table story_sends enable row level security;
revoke all on story_sends from anon, authenticated;
