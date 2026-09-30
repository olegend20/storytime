-- F12 / DECISIONS #132: the primary quality-system goal is fewer rewrites, so it needs a
-- number. From generation_logs, never application memory (CLAUDE.md conventions).
--
--   writes        first drafts written
--   rewrites      first drafts the gate sent back
--   rewrite_rate  rewrites / writes
--   repairs       story JSON that needed a model repair call (should be ~0 with structured outputs)
--   avg_write_output_tokens  what the writer generates per story, thinking included
create or replace view public.v_first_draft_health
with (security_invoker = on) as
with w as (
  select date_trunc('day', created_at) as day,
         count(*) filter (where purpose = 'write' and ok) as writes,
         count(*) filter (where purpose = 'rewrite' and ok) as rewrites,
         count(*) filter (where purpose = 'repair') as repairs,
         avg(output_tokens) filter (where purpose = 'write' and ok) as avg_write_output_tokens,
         sum(cost_usd) filter (where purpose in ('write', 'rewrite', 'repair')) as writer_usd
  from public.generation_logs
  group by 1
)
select day, writes, rewrites,
       case when writes = 0 then null else round(rewrites::numeric / writes, 3) end as rewrite_rate,
       repairs,
       round(avg_write_output_tokens) as avg_write_output_tokens,
       round(writer_usd, 4) as writer_usd
from w
order by day desc;

revoke all on public.v_first_draft_health from anon, authenticated;
