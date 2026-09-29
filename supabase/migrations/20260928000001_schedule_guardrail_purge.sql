-- GUARDRAILS.md s1.5: the raw text of a refused input is kept for at most 24 hours.
-- 20260927000004 created purge_guardrail_raw_text() but nothing ever ran it, so raw text
-- was in practice kept forever - and /privacy tells parents it is deleted within a day.
-- Hourly keeps the worst case at 25 hours.
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'purge-guardrail-raw-text',
  '0 * * * *',
  $$select public.purge_guardrail_raw_text()$$
);
