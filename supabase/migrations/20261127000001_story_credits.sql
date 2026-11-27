-- Story credits (issue #128). A family has a balance of stories, starting with three free ones.
--
-- Groundwork for paid plans. Nothing here limits anyone on its own: the app only looks at the
-- balance when STORY_CREDITS_ENABLED=true, and the 3-a-day limit (daily_usage) is untouched.
--
-- One row per GRANT of stories, not per story. `remaining` counts down as stories are saved;
-- the balance is the sum of `remaining` over grants that have not expired. Stories are taken
-- from the grant that expires soonest, so a month's allowance is used before a pack that
-- never expires (owner's decision 4 on #128).
--
-- `source_ref` is what makes granting safe to repeat: a payment webhook delivered twice
-- names the same reference and adds stories once.
--
-- Holds nothing about a child (CLAUDE.md rule 7). Family-scoped, so RLS is on: a family can
-- read its own grants and write none; both functions are service role only.

create table story_credit_grants (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references families (id) on delete cascade,
  amount      int  not null check (amount > 0),
  remaining   int  not null check (remaining >= 0),
  reason      text not null check (reason in ('trial', 'subscription', 'top_up', 'adjustment')),
  -- Null = never expires (the trial, top-up packs).
  expires_at  timestamptz,
  source_ref  text not null unique check (char_length(source_ref) between 1 and 200),
  created_at  timestamptz not null default now(),
  check (remaining <= amount)
);

create index story_credit_grants_family_idx on story_credit_grants (family_id, expires_at);

alter table story_credit_grants enable row level security;

create policy story_credit_grants_select on story_credit_grants for select
  using (family_id in (select owned_family_ids()));

-- Read-only for a signed-in parent; nothing at all for anon.
revoke all on story_credit_grants from anon;
revoke insert, update, delete, truncate, trigger, references on story_credit_grants from authenticated;

-- ============================================================ grant
--
-- Returns one row: whether a grant was added (false = this source_ref was already granted),
-- and the family's balance afterwards.
create or replace function grant_story_credits(
  p_family_id  uuid,
  p_amount     int,
  p_reason     text,
  p_source_ref text,
  p_expires_at timestamptz default null
)
returns table (granted boolean, balance int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into story_credit_grants (family_id, amount, remaining, reason, expires_at, source_ref)
  values (p_family_id, p_amount, p_amount, p_reason, p_expires_at, p_source_ref)
  on conflict (source_ref) do nothing
  returning id into v_id;

  return query
    select v_id is not null,
           coalesce(sum(g.remaining), 0)::int
      from story_credit_grants g
     where g.family_id = p_family_id
       and (g.expires_at is null or g.expires_at > now());
end;
$$;

comment on function grant_story_credits is
  'Issue #128: add stories to a family''s balance, once per source_ref. Service role only.';

-- ============================================================ take one story
--
-- Returns one row: whether a story was taken (false = the balance was already 0), and the
-- balance afterwards. The per-family advisory lock is what stops two stories saved at the
-- same moment from both taking the last one, or from one of them finding its chosen grant
-- emptied and wrongly reporting an empty balance while another grant still has stories.
create or replace function consume_story_credit(p_family_id uuid)
returns table (taken boolean, balance int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('story_credits:' || p_family_id::text, 0));

  select g.id into v_id
    from story_credit_grants g
   where g.family_id = p_family_id
     and g.remaining > 0
     and (g.expires_at is null or g.expires_at > now())
   order by g.expires_at asc nulls last, g.created_at asc, g.id asc
   limit 1;

  if v_id is not null then
    update story_credit_grants set remaining = remaining - 1 where id = v_id;
  end if;

  return query
    select v_id is not null,
           coalesce(sum(g.remaining), 0)::int
      from story_credit_grants g
     where g.family_id = p_family_id
       and (g.expires_at is null or g.expires_at > now());
end;
$$;

comment on function consume_story_credit is
  'Issue #128: take one story from the grant that expires soonest. Call ONLY from the service '
  'role, and only after a successful stories insert - refusals and failures are free.';

revoke all on function grant_story_credits(uuid, int, text, text, timestamptz) from public;
revoke all on function grant_story_credits(uuid, int, text, text, timestamptz) from anon, authenticated;
grant execute on function grant_story_credits(uuid, int, text, text, timestamptz) to service_role;

revoke all on function consume_story_credit(uuid) from public;
revoke all on function consume_story_credit(uuid) from anon, authenticated;
grant execute on function consume_story_credit(uuid) to service_role;

-- ============================================================ the three free stories
--
-- Every new family starts with three, whoever inserts the row (a parent's own session
-- creates it, and cannot write a grant itself - hence security definer, with search_path
-- pinned). `trial:<family id>` as the reference means a family can only ever have one.
create or replace function grant_trial_story_credits()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into story_credit_grants (family_id, amount, remaining, reason, source_ref)
  values (new.id, 3, 3, 'trial', 'trial:' || new.id::text)
  on conflict (source_ref) do nothing;
  return new;
end;
$$;

revoke execute on function grant_trial_story_credits() from public, anon, authenticated;

create trigger families_grant_trial_story_credits
  after insert on families
  for each row execute function grant_trial_story_credits();

-- Families that already exist get the same three, whatever they have made so far (owner's
-- decision 2 on #128). Nothing is counted against them until the switch is on.
insert into story_credit_grants (family_id, amount, remaining, reason, source_ref)
select f.id, 3, 3, 'trial', 'trial:' || f.id::text
  from families f
on conflict (source_ref) do nothing;
