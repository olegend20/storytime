-- F8 (quotas, budget cap) + F12 (admin dashboard) — lane 3.
--
-- Three jobs:
--   1. An atomic, limit-checked quota increment (`insert ... on conflict`), callable only
--      by the service role, so a client can never reset or inflate its own quota.
--   2. Extra admin views F12 needs that 20260927000003_admin_views.sql does not provide:
--      today's spend (budget cap), latency, flagged-story rate, per-writer median cost,
--      a fact-pack hit-rate trend, and a median that ignores story rows with no logs.
--   3. Lock the admin views down. `anon` could read `v_daily_costs` before this migration
--      (views are owned by postgres, so they bypass RLS on generation_logs, and the public
--      schema's default grants give anon/authenticated SELECT). Cost data is owner-only.
--
-- Never edits an applied migration — additions only.

-- ============================================================ F8 quota increment
--
-- Returns one row: whether the increment happened, and the resulting count.
-- The `where` on the conflict target is what makes the limit check atomic: two concurrent
-- requests at count = 2 cannot both become 3.
create or replace function consume_daily_quota(
  p_family_id  uuid,
  p_usage_date date,
  p_limit      int
)
returns table (allowed boolean, used int, day_limit int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_new_count int;
  v_existing  int;
begin
  if p_limit < 1 then
    raise exception 'consume_daily_quota: p_limit must be >= 1, got %', p_limit;
  end if;

  insert into daily_usage (family_id, usage_date, count)
  values (p_family_id, p_usage_date, 1)
  on conflict (family_id, usage_date) do update
     set count = daily_usage.count + 1
   where daily_usage.count < p_limit
  returning daily_usage.count into v_new_count;

  if v_new_count is not null then
    return query select true, v_new_count, p_limit;
    return;
  end if;

  -- Conflict update was skipped: the family is already at (or over) the limit.
  select du.count into v_existing
    from daily_usage du
   where du.family_id = p_family_id and du.usage_date = p_usage_date;

  return query select false, coalesce(v_existing, 0), p_limit;
end;
$$;

comment on function consume_daily_quota is
  'F8: atomic limit-checked daily quota increment. Call ONLY from the service role, and '
  'only after a successful stories insert — refusals and failures are free.';

-- A client must not be able to move its own quota. RLS already blocks writes to
-- daily_usage; this closes the function as well.
revoke all on function consume_daily_quota(uuid, date, int) from public;
revoke all on function consume_daily_quota(uuid, date, int) from anon, authenticated;
grant execute on function consume_daily_quota(uuid, date, int) to service_role;

-- ============================================================ F8 budget cap
--
-- Today's spend across every model call, for the DAILY_BUDGET_USD kill switch. "Today" is
-- the database day (UTC on Supabase): the budget is a single global cap, so it cannot key
-- off any one family's timezone the way the per-family quota does.
create or replace view v_budget_today as
select
  current_date                                     as day,
  coalesce(sum(cost_usd), 0)::numeric(12, 6)       as spent_usd,
  count(*)                                         as calls,
  count(*) filter (where not ok)                   as failed_calls
from generation_logs
where created_at >= date_trunc('day', now());

comment on view v_budget_today is
  'F8: spend so far on the current database day. Compared against DAILY_BUDGET_USD.';

-- ============================================================ F12 extra views

-- Median / p95 cost per story over stories that actually have log rows. v_cost_summary
-- left-joins generation_logs, so story rows written without logs (fixtures, seeds, other
-- lanes'' tests) enter the distribution at $0 and drag the median down. The dashboard
-- headline uses this one and shows both counts so the gap is visible.
create or replace view v_story_cost_summary as
select
  count(*)                                                          as stories_with_logs,
  percentile_cont(0.5)  within group (order by cost_usd)             as median_cost_usd,
  percentile_cont(0.95) within group (order by cost_usd)             as p95_cost_usd,
  avg(cost_usd)                                                     as avg_cost_usd,
  min(cost_usd)                                                     as min_cost_usd,
  max(cost_usd)                                                     as max_cost_usd
from v_story_costs
where cost_usd > 0;

-- Which writing model produced each story, and what that story cost end to end. The
-- writer is the most expensive 'write'/'rewrite' call on the story.
create or replace view v_story_writer as
select distinct on (g.story_id)
  g.story_id,
  g.model as writer_model
from generation_logs g
where g.story_id is not null
  and g.purpose in ('write', 'rewrite')
order by g.story_id, g.cost_usd desc;

-- Median cost per story per writing model. The expected band from IMPLEMENTATION_PLAN §5
-- is roughly $0.045 (Haiku 4.5) / $0.071 (Sonnet 5) / $0.125 (Opus 5.5) / $0.284
-- (Fable 5.1). A median far outside it means the token mix, not the price table, is wrong.
create or replace view v_story_cost_by_writer as
select
  w.writer_model                                              as model,
  count(*)                                                    as stories,
  percentile_cont(0.5)  within group (order by sc.cost_usd)   as median_cost_usd,
  percentile_cont(0.95) within group (order by sc.cost_usd)   as p95_cost_usd,
  avg(sc.cost_usd)                                            as avg_cost_usd
from v_story_writer w
join v_story_costs sc on sc.story_id = w.story_id
group by w.writer_model;

-- Flagged / failed story rate. v_daily_stories has the per-day counts; this is the
-- headline rate over all stories plus the last 30 days.
create or replace view v_story_health as
select
  count(*)                                                                  as stories,
  count(*) filter (where status = 'flagged')                                as flagged,
  count(*) filter (where status = 'failed')                                 as failed,
  case when count(*) = 0 then null
       else count(*) filter (where status = 'flagged')::numeric / count(*)
  end                                                                       as flagged_rate,
  count(*) filter (where created_at >= now() - interval '30 days')          as stories_30d,
  case when count(*) filter (where created_at >= now() - interval '30 days') = 0 then null
       else count(*) filter (where status = 'flagged'
                               and created_at >= now() - interval '30 days')::numeric
            / count(*) filter (where created_at >= now() - interval '30 days')
  end                                                                       as flagged_rate_30d
from stories;

-- Average and p95 latency per call purpose, plus the cache-read ratio for that purpose.
create or replace view v_latency_summary as
select
  purpose,
  count(*)                                                                  as calls,
  count(*) filter (where not ok)                                            as failed_calls,
  avg(latency_ms)                                                           as avg_latency_ms,
  percentile_cont(0.95) within group (order by latency_ms)                  as p95_latency_ms,
  sum(cost_usd)                                                             as cost_usd,
  case when sum(cache_read_tokens + input_tokens) = 0 then null
       else sum(cache_read_tokens)::numeric / sum(cache_read_tokens + input_tokens)
  end                                                                       as cache_read_ratio
from generation_logs
where latency_ms is not null
group by purpose;

-- Fact-pack hit rate per day, so the dashboard can show the trend towards the §5 target
-- of ≥ 80% after 500 stories (the all-time view flattens it).
create or replace view v_fact_pack_hit_rate_daily as
select
  date_trunc('day', s.created_at)::date                             as day,
  count(*)                                                          as stories,
  count(*) filter (where fp.created_at < s.created_at)              as hits,
  case when count(*) = 0 then null
       else count(*) filter (where fp.created_at < s.created_at)::numeric / count(*)
  end                                                               as hit_rate
from stories s
left join fact_packs fp on fp.id = s.fact_pack_id
group by 1;

-- ============================================================ lock the views down
--
-- Cost and volume data is owner-only (F12). The dashboard reads it with the service role,
-- which bypasses RLS, so removing the anon/authenticated grants costs the app nothing.
do $$
declare v text;
begin
  foreach v in array array[
    'v_daily_costs', 'v_daily_stories', 'v_story_costs', 'v_cost_summary',
    'v_fact_pack_hit_rate', 'v_budget_today', 'v_story_cost_summary', 'v_story_writer',
    'v_story_cost_by_writer', 'v_story_health', 'v_latency_summary',
    'v_fact_pack_hit_rate_daily'
  ]
  loop
    execute format('revoke all on %I from anon, authenticated', v);
    -- Belt and braces: even if a grant comes back via default privileges, an invoker-rights
    -- view applies the caller's RLS to the base tables, so a client still sees nothing.
    execute format('alter view %I set (security_invoker = on)', v);
    execute format('grant select on %I to service_role', v);
  end loop;
end;
$$;

-- v_top_topics stays readable by signed-in parents: F10 sources its suggested-topic chips
-- from the most-used fact packs. security_invoker means fact_packs'' own RLS policy
-- (status = 'ready' only) applies, which is exactly the intended exposure.
alter view v_top_topics set (security_invoker = on);
grant select on v_top_topics to authenticated, service_role;
revoke all on v_top_topics from anon;
