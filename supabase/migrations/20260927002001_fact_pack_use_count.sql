-- F5: atomic `use_count` increment for fact packs.
--
-- A popular topic is fetched concurrently by many families at bedtime. A read-modify-write
-- from application code loses increments under that load (measured: 8 concurrent callers
-- landed 5 increments with a compare-and-swap loop), and `use_count` feeds the §5 target
-- "fact-pack cache hit rate >= 80% after 500 stories" plus the F12 admin views - a counter
-- that silently under-reports makes that number meaningless.
--
-- SECURITY DEFINER because fact_packs is service-role-write-only; EXECUTE is granted to
-- service_role alone so a client cannot inflate another family's usage stats.
--
-- Additive migration: it creates a function and changes no table (LANE_BRIEF - never edit an
-- applied migration; other lanes share this database).

create or replace function increment_fact_pack_use(p_id uuid)
returns int
language sql
security definer
set search_path = public
as $$
  update fact_packs
     set use_count = use_count + 1
   where id = p_id
  returning use_count;
$$;

revoke all on function increment_fact_pack_use(uuid) from public;
revoke all on function increment_fact_pack_use(uuid) from anon;
revoke all on function increment_fact_pack_use(uuid) from authenticated;
grant execute on function increment_fact_pack_use(uuid) to service_role;
