-- Send to Kindle: the daily limit is the family's own calendar day, like the story quota
-- (lib/limits/timezone usageDateFor), not a rolling 24 hours. Code review on PR #12.
alter table story_sends add column usage_date date not null default (now() at time zone 'utc')::date;
drop index if exists story_sends_family_day;
create index story_sends_family_usage_date on story_sends (family_id, usage_date);
