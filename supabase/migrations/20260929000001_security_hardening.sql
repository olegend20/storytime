-- Security hardening from the 2026-09-29 audit (see PROGRESS.md). Nothing here loosens a
-- rule: every change removes access the app never uses, or enforces a limit the app already
-- enforces, at the layer a direct API caller cannot skip.

-- ---------------------------------------------------------------------------------------
-- 1. Anonymous callers get nothing. Supabase grants `anon` every privilege on every table
--    by default (including TRUNCATE, which RLS does not cover). No StoryTime page reads a
--    table while signed out - the landing, login and privacy pages are static - so anon
--    needs no table access at all. RLS already returned zero rows; this removes the grant.
-- ---------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

-- Signed-in users never need to truncate, add triggers or reference tables.
revoke truncate, trigger, references on all tables in schema public from authenticated;

-- ---------------------------------------------------------------------------------------
-- 2. Server-only writes. Stories, series and story bibles are written only by the
--    generation pipeline, with the service role. The INSERT/UPDATE policies let a signed-in
--    user write their own rows straight through the REST API instead - and a story bible is
--    pasted into every story prompt, so a user could store an arbitrarily large bible and
--    make every one of their stories cost us more, with no guardrail seeing it.
--    Kept: SELECT on all three (library, reader), and DELETE on stories (F9 delete).
-- ---------------------------------------------------------------------------------------
drop policy if exists stories_insert on stories;
drop policy if exists stories_update on stories;
drop policy if exists series_insert on series;
drop policy if exists series_update on series;
drop policy if exists story_bibles_insert on story_bibles;
drop policy if exists story_bibles_update on story_bibles;
drop policy if exists series_delete on series;
drop policy if exists story_bibles_delete on story_bibles;
revoke insert, update on stories, series, story_bibles from authenticated;
revoke delete on series, story_bibles from authenticated;

-- ---------------------------------------------------------------------------------------
-- 3. The same prompt-cost route through children: likes are capped at ten by the schema,
--    but not in length, so ten 100k-character likes passed. Match ChildLike (lib/schemas).
-- ---------------------------------------------------------------------------------------
create or replace function public.child_likes_ok(likes text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(char_length(l) between 1 and 40), true) from unnest(likes) as l
$$;
alter table children
  add constraint children_likes_items_check check (public.child_likes_ok(likes));

-- ---------------------------------------------------------------------------------------
-- 4. Functions. Pin search_path on the two that lacked it (Supabase lint 0011): the RLS
--    helper every family policy calls, and the updated_at trigger. And the retention purge
--    runs as its owner (SECURITY DEFINER) - nobody but the service role and pg_cron should
--    be able to call it through the API.
-- ---------------------------------------------------------------------------------------
alter function public.owned_family_ids() set search_path = public, pg_temp;
alter function public.set_updated_at() set search_path = public, pg_temp;
revoke execute on function public.purge_guardrail_raw_text() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
