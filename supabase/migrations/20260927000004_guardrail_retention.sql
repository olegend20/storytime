-- GUARDRAILS.md s1.5 / F15 VT: never keep the raw text of a refused input beyond 24h.
-- The hash, layer and category are retained indefinitely so blocklists and the
-- classifier can be improved from real traffic.

create or replace function purge_guardrail_raw_text() returns integer
language plpgsql security definer set search_path = public as $$
declare purged integer;
begin
  update guardrail_events
     set raw_text = null
   where raw_text is not null
     and created_at < now() - interval '24 hours';
  get diagnostics purged = row_count;
  return purged;
end;
$$;

comment on function purge_guardrail_raw_text is
  'Run at least hourly (pg_cron or a Vercel cron hitting an admin route). Nulls raw_text on guardrail_events older than 24h. F15 retention VT calls this directly.';
