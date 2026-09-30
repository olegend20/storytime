-- Row-level security. Kickoff rule 7: RLS on every family-scoped table.
--
-- F2 VT: user A selecting user B's rows must get ZERO ROWS, not an error - so these are
-- permissive select policies scoped by family ownership, not table-level revokes.

alter table families         enable row level security;
alter table children         enable row level security;
alter table series           enable row level security;
alter table story_bibles     enable row level security;
alter table stories          enable row level security;
alter table daily_usage      enable row level security;
alter table fact_packs       enable row level security;
alter table generation_logs  enable row level security;
alter table guardrail_events enable row level security;

-- Families this user owns, excluding soft-deleted ones.
create or replace function owned_family_ids() returns setof uuid
language sql stable security invoker as $$
  select id from families
  where owner_user_id = auth.uid() and deleted_at is null;
$$;

-- ---------------------------------------------------------------- families
create policy families_select on families for select
  using (owner_user_id = auth.uid() and deleted_at is null);
create policy families_insert on families for insert
  with check (owner_user_id = auth.uid());
create policy families_update on families for update
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
create policy families_delete on families for delete
  using (owner_user_id = auth.uid());

-- ------------------------------------------------- family-scoped tables (CRUD)
do $$
declare t text;
begin
  foreach t in array array['children', 'series', 'story_bibles', 'stories']
  loop
    execute format($f$
      create policy %1$s_select on %1$s for select
        using (family_id in (select owned_family_ids()));
      create policy %1$s_insert on %1$s for insert
        with check (family_id in (select owned_family_ids()));
      create policy %1$s_update on %1$s for update
        using (family_id in (select owned_family_ids()))
        with check (family_id in (select owned_family_ids()));
      create policy %1$s_delete on %1$s for delete
        using (family_id in (select owned_family_ids()));
    $f$, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- daily_usage
-- Readable by the family (the UI shows "2 of 3 stories left today"), but writable
-- only by the service role, so a client cannot reset its own quota.
create policy daily_usage_select on daily_usage for select
  using (family_id in (select owned_family_ids()));

-- ---------------------------------------------------------------- fact_packs
-- s3: read-only for all authenticated users, write only via the service role.
create policy fact_packs_select on fact_packs for select
  to authenticated using (status = 'ready');

-- ---------------------------------------------------------------- service-role only
-- generation_logs and guardrail_events get NO policies at all: with RLS enabled and
-- no permissive policy, anon/authenticated clients see nothing, while the service role
-- bypasses RLS entirely. That is the intended access model (s3).
