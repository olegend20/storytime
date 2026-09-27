-- F12 AC: all admin numbers come from SQL views over generation_logs and stories,
-- never from application memory.

create or replace view v_daily_costs as
select
  date_trunc('day', created_at)::date as day,
  count(*)                            as calls,
  count(*) filter (where not ok)      as failed_calls,
  sum(cost_usd)                       as cost_usd,
  sum(input_tokens)                   as input_tokens,
  sum(cache_read_tokens)              as cache_read_tokens,
  sum(cache_write_tokens)             as cache_write_tokens,
  sum(output_tokens)                  as output_tokens
from generation_logs
group by 1;

create or replace view v_daily_stories as
select
  date_trunc('day', created_at)::date                      as day,
  count(*)                                                 as stories,
  count(*) filter (where status = 'flagged')               as flagged,
  count(*) filter (where status = 'failed')                as failed,
  count(*) filter (where fact_pack_id is not null)         as with_fact_pack,
  avg(word_count)                                          as avg_word_count
from stories
group by 1;

-- Per-story cost: every log row carrying that story_id.
create or replace view v_story_costs as
select
  s.id           as story_id,
  s.family_id,
  s.created_at,
  s.status,
  s.topic_key,
  coalesce(sum(g.cost_usd), 0) as cost_usd,
  coalesce(sum(g.latency_ms) filter (where g.purpose in ('write', 'rewrite')), 0) as write_latency_ms
from stories s
left join generation_logs g on g.story_id = s.id
group by s.id, s.family_id, s.created_at, s.status, s.topic_key;

-- Median and p95 cost per story, plus the cache-read ratio on writing calls.
create or replace view v_cost_summary as
select
  (select percentile_cont(0.5) within group (order by cost_usd) from v_story_costs) as median_cost_usd,
  (select percentile_cont(0.95) within group (order by cost_usd) from v_story_costs) as p95_cost_usd,
  (select coalesce(sum(cost_usd), 0) from generation_logs)                           as total_cost_usd,
  (
    select case
      when sum(cache_read_tokens + input_tokens) = 0 then null
      else sum(cache_read_tokens)::numeric / sum(cache_read_tokens + input_tokens)
    end
    from generation_logs where purpose in ('write', 'rewrite')
  ) as write_cache_read_ratio;

-- Fact-pack hit rate: a "hit" is a story reusing a pack built before it.
create or replace view v_fact_pack_hit_rate as
select
  count(*)                                                as stories,
  count(*) filter (where fp.created_at < s.created_at)    as hits,
  case when count(*) = 0 then null
       else count(*) filter (where fp.created_at < s.created_at)::numeric / count(*)
  end                                                     as hit_rate
from stories s
left join fact_packs fp on fp.id = s.fact_pack_id;

create or replace view v_top_topics as
select topic_key, topic_label, use_count, quality_score
from fact_packs
where status = 'ready'
order by use_count desc;
