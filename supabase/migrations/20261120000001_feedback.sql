-- Tester feedback (owner request 2026-11-20). lastten.org/feedback lets an approved tester
-- say how StoryTime has gone, whenever they are ready, signed in or not.
--
-- Answers about the product, an optional name and an optional email for a reply. No field
-- about a child (CLAUDE.md rule 7): the form asks for none, and a parent's own words are the
-- only place a child can appear.
--
-- Service role only, like the waitlist: RLS on, no policies, no grants to anon or
-- authenticated. POST /api/feedback is the only way in, and nobody can read the answers
-- through the public API. The owner reads them in Supabase.

create table feedback (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  enjoyment     text check (enjoyment in ('loved', 'liked', 'mixed', 'not_for_us')),
  stories_read  text check (stories_read in ('none', 'one', 'few', 'many')),
  loved         text check (char_length(loved) <= 2000),
  confusing     text check (char_length(confusing) <= 2000),
  reading_on    text[] check (reading_on <@ array['phone', 'tablet', 'computer', 'ereader', 'printed', 'other']),
  wish          text check (char_length(wish) <= 2000),
  keep_using    text check (keep_using in ('most_nights', 'sometimes', 'probably_not', 'not_sure')),
  anything_else text check (char_length(anything_else) <= 2000),
  name          text check (char_length(name) <= 80),
  email         text check (email = lower(email) and char_length(email) between 3 and 254)
);

create index feedback_created_idx on feedback (created_at desc);

alter table feedback enable row level security;
revoke all on feedback from anon, authenticated;
