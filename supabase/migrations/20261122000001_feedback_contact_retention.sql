-- Tester feedback retention (owner decision 2026-11-22, DECISIONS #225): a tester's name and
-- email are deleted 90 days after they send feedback. Their answers are kept, with nothing
-- left that says who wrote them, so we can keep learning from them.
--
-- Same shape as the guardrail raw-text purge (20260927000004 / 20260928000001): a function
-- that clears the columns, scheduled by pg_cron, callable only by the server. Daily keeps
-- the worst case at 91 days.

create or replace function public.purge_feedback_contact() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare purged integer;
begin
  update feedback
     set name = null, email = null
   where (name is not null or email is not null)
     and created_at < now() - interval '90 days';
  get diagnostics purged = row_count;
  return purged;
end;
$$;

comment on function public.purge_feedback_contact is
  'Run daily by pg_cron. Clears name and email on feedback older than 90 days; keeps the answers.';

revoke execute on function public.purge_feedback_contact() from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'purge-feedback-contact',
  '17 3 * * *',
  $$select public.purge_feedback_contact()$$
);
